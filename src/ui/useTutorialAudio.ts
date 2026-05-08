import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";

// Owner of the helper bubble's audio playback. Plays the clip for the
// current tour stop, tears it down on stop swaps / unmount, and exposes
// the mute + replay handles the bubble renders as icons.
//
// Mute persists to localStorage so a player's preference carries across
// sessions without a dedicated settings page entry.

const STORAGE_KEY = "ledgway:tutorial-audio-muted";
const VOLUME_KEY = "ledgway:tutorial-audio-volume";
// Default playback volume — half-strength so the orb's voice doesn't
// drown out game audio on first load. Persisted per-player via the
// VOLUME_KEY localStorage entry.
const DEFAULT_VOLUME = 0.5;

export interface TutorialAudioControls {
  muted: boolean;
  toggleMute: () => void;
  replay: () => void;
  // True when the browser blocked our autoplay attempt (NotAllowedError).
  // The bubble can use this to nudge the player toward clicking. We
  // also auto-retry on the next pointer/key event, so the moment the
  // player clicks Next (or anywhere else), audio unlocks for the rest
  // of the session.
  needsActivation: boolean;
  // Live RMS level (0..1) of the currently-playing clip, computed by
  // a Web Audio AnalyserNode. Exposed as a ref because it updates
  // every frame and consumers should poll it imperatively rather than
  // re-render. Stays at 0 when nothing is playing or audio is muted.
  vocalVolume: MutableRefObject<number>;
  // Persisted playback volume in [0, 1]. The bubble's slider drives
  // setVolume; the gain node mirrors this whenever it (or muted)
  // changes. Setting volume while muted leaves mute on — the new
  // value just takes effect once mute is toggled back off.
  volume: number;
  setVolume: (v: number) => void;
}

function readMuted(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeMuted(muted: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, muted ? "1" : "0");
  } catch {
    // Private mode / quota — nothing to do.
  }
}

function readVolume(): number {
  if (typeof window === "undefined") return DEFAULT_VOLUME;
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    if (raw === null) return DEFAULT_VOLUME;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_VOLUME;
    return Math.max(0, Math.min(1, n));
  } catch {
    return DEFAULT_VOLUME;
  }
}

function writeVolume(volume: number): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(VOLUME_KEY, String(volume));
  } catch {
    // Private mode / quota — nothing to do.
  }
}

export function useTutorialAudio(src: string | null): TutorialAudioControls {
  const [muted, setMuted] = useState<boolean>(() => readMuted());
  const [volume, setVolumeState] = useState<number>(() => readVolume());
  const [replayKey, setReplayKey] = useState(0);
  const [needsActivation, setNeedsActivation] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  // Lazy singleton AudioContext — reused across clips so we don't leak
  // an OS-level audio device per replay. Only created the first time a
  // clip plays, so SSR / no-audio environments don't pay anything.
  const audioCtxRef = useRef<AudioContext | null>(null);
  // GainNode sitting between source and destination. Once we route the
  // audio element through Web Audio, its element.muted is bypassed —
  // so muting has to happen here. Held in a ref so the mute mirror
  // effect can adjust it without re-running the playback effect.
  const gainRef = useRef<GainNode | null>(null);
  // Live RMS readout from the analyser, written each frame by the
  // analysis rAF below. Surfaced to consumers as part of the controls.
  const vocalVolumeRef = useRef(0);

  // Mirror mute + volume into the gain node. Web Audio gain is the
  // canonical attenuation path once the analyser graph is connected;
  // element.muted is kept in sync as a fallback for the brief window
  // before the graph exists. Muted forces gain to 0 regardless of
  // the volume slider, so toggling mute back off restores the slider
  // value rather than full strength.
  useEffect(() => {
    writeMuted(muted);
    const gain = gainRef.current;
    if (gain) {
      gain.gain.setValueAtTime(
        muted ? 0 : volume,
        gain.context.currentTime,
      );
    }
    if (audioRef.current) audioRef.current.muted = muted;
  }, [muted, volume]);

  useEffect(() => {
    // Tear down the previous clip first; reusing the element leaks the
    // src buffer and causes occasional double-play on rapid stop swaps.
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    vocalVolumeRef.current = 0;
    setNeedsActivation(false);
    if (!src) return;

    const audio = new Audio(src);
    audio.preload = "auto";
    audio.muted = muted;
    audioRef.current = audio;

    // Wire the audio through a Web Audio graph for live volume
    // analysis. Layout: source → gain → analyser → destination.
    // The gain node is our mute control (element.muted is ignored once
    // the audio is routed through MediaElementAudioSource). The
    // analyser feeds an rAF loop that writes RMS to vocalVolumeRef.
    let analyserRaf = 0;
    let source: MediaElementAudioSourceNode | null = null;
    let gain: GainNode | null = null;
    let analyser: AnalyserNode | null = null;
    try {
      if (!audioCtxRef.current) {
        type AudioCtor = typeof AudioContext;
        const Ctor: AudioCtor | undefined =
          window.AudioContext ??
          (window as unknown as { webkitAudioContext?: AudioCtor }).webkitAudioContext;
        if (Ctor) audioCtxRef.current = new Ctor();
      }
      const ctx = audioCtxRef.current;
      if (ctx) {
        // Most browsers create the context suspended until a user
        // gesture. play() itself counts as a resume trigger, but we
        // call it explicitly to be safe — no-op when already running.
        if (ctx.state === "suspended") void ctx.resume();
        source = ctx.createMediaElementSource(audio);
        gain = ctx.createGain();
        gain.gain.value = muted ? 0 : volume;
        analyser = ctx.createAnalyser();
        // Small fftSize keeps the time-domain RMS computation cheap;
        // 256 samples ~5ms at 48kHz, plenty fast for syllable-rate
        // envelope tracking.
        analyser.fftSize = 256;
        source.connect(gain);
        gain.connect(analyser);
        gain.connect(ctx.destination);
        gainRef.current = gain;

        const buf = new Uint8Array(analyser.fftSize);
        // EMA smoothing on the volume envelope. Time-domain RMS is
        // raw at the analyser (no built-in smoothingTimeConstant —
        // that one only applies to FFT bins), so it tracks every
        // syllable edge faithfully and reads as flickery on a light.
        // Asymmetric blends — fast on attack, slow on release — keep
        // syllables crisp while preventing the "shaky" decay between
        // them.
        const ATTACK = 0.5;  // higher = faster catch-up on rising edges
        const RELEASE = 0.12; // lower = slower decay between syllables
        const tick = () => {
          analyser!.getByteTimeDomainData(buf);
          let sum = 0;
          for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
          }
          const rms = Math.sqrt(sum / buf.length);
          // Voice peaks tend to land around RMS 0.2–0.3; ×4 maps a
          // typical loud syllable to ~1.0 with quiet speech sitting
          // around 0.3–0.5. Clamp the rest.
          const target = Math.min(1, rms * 4);
          const prev = vocalVolumeRef.current;
          const blend = target > prev ? ATTACK : RELEASE;
          vocalVolumeRef.current = prev + (target - prev) * blend;
          analyserRaf = requestAnimationFrame(tick);
        };
        analyserRaf = requestAnimationFrame(tick);
      }
    } catch (err) {
      // createMediaElementSource throws if this element is already
      // bound to another MediaElementSource (shouldn't happen — we
      // create a fresh element above) or if the browser refuses for
      // some other reason. Fall back to no analysis; audio still plays.
      console.warn("[tutorial-audio] analyser unavailable:", err);
    }

    // Browser autoplay policies require "sticky activation" — a click /
    // tap / key event somewhere in the document. The wizard clicks
    // grant that, but a refresh mid-tour or a save loaded directly into
    // a tour stop has no prior gesture, so play() rejects with
    // NotAllowedError. We flag the bubble (so it can prompt the player)
    // and listen for the next gesture anywhere on the page. Once that
    // arrives, the retry succeeds and unlocks audio for the rest of
    // the session — every subsequent stop autoplays normally.
    void audio.play().catch(err => {
      const blocked = err instanceof DOMException && err.name === "NotAllowedError";
      if (!blocked) {
        console.warn("[tutorial-audio] play failed:", err);
        return;
      }
      setNeedsActivation(true);
    });

    return () => {
      if (analyserRaf) cancelAnimationFrame(analyserRaf);
      try {
        source?.disconnect();
        gain?.disconnect();
        analyser?.disconnect();
      } catch {
        // Disconnect on already-disconnected nodes throws — ignore.
      }
      if (gainRef.current === gain) gainRef.current = null;
      audio.pause();
      audio.src = "";
      if (audioRef.current === audio) audioRef.current = null;
      vocalVolumeRef.current = 0;
    };
    // muted is intentionally excluded — see the mirror effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, replayKey]);

  // Recovery: when an autoplay attempt was blocked, the next user
  // gesture anywhere in the document is our cue to retry. Sticky
  // activation persists for the lifetime of the document once granted,
  // so this only ever fires once per session.
  useEffect(() => {
    if (!needsActivation) return;
    const tryPlay = () => {
      const audio = audioRef.current;
      if (!audio) return;
      audio.play().then(() => {
        setNeedsActivation(false);
      }).catch(() => {
        // Still blocked (rare — usually means no audio element). Leave
        // the flag on; the next gesture will retry.
      });
    };
    document.addEventListener("pointerdown", tryPlay, { passive: true });
    document.addEventListener("keydown", tryPlay);
    return () => {
      document.removeEventListener("pointerdown", tryPlay);
      document.removeEventListener("keydown", tryPlay);
    };
  }, [needsActivation]);

  const toggleMute = useCallback(() => setMuted(prev => !prev), []);
  const replay = useCallback(() => setReplayKey(k => k + 1), []);
  const setVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v));
    writeVolume(clamped);
    setVolumeState(clamped);
  }, []);

  return {
    muted,
    toggleMute,
    replay,
    needsActivation,
    vocalVolume: vocalVolumeRef,
    volume,
    setVolume,
  };
}
