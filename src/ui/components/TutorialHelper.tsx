import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { MdReplay, MdVolumeOff, MdVolumeUp } from "react-icons/md";
import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  Mesh,
  MeshBasicMaterial,
  PointLight,
  Points,
  ShaderMaterial,
  SphereGeometry,
} from "three";
import "@google/model-viewer";
// Reach into model-viewer's internals to grab the THREE scene. $scene
// is a Symbol() (not Symbol.for) so it's only accessible by importing
// the same symbol instance the library uses. Stable across 4.x.
import { $scene } from "@google/model-viewer/lib/model-viewer-base.js";
import "./TutorialHelper.css";
import type { TutorialAudioControls } from "../useTutorialAudio";

// ────────────────────────────────────────────────────────────────────
// Orb light rig — declarative config for the in-scene PointLights
// attached to the helper model. Add an entry to ORB_LIGHTS to spawn
// another light; the runtime walks the array and creates them all.
//
// Per-light animation is dispatched on `animation.kind`:
//   - "static": intensity is fixed to the config value forever.
//   - "vocal": intensity = baseline + vocalVolume * peak, polled every
//     frame from the audio analyser (when audioControls is provided).
//   - "flicker": resamples a random target intensity in [baseline,
//     baseline+peak] at `rate` Hz and eases toward it — reads as a
//     candle / dying bulb. Higher rate = jittery, lower = lazy flame.
//   New variants get their own kind entries and a matching switch arm
//   in the per-frame update loop.
// ────────────────────────────────────────────────────────────────────

type OrbLightAnimation =
  | { kind: "static" }
  | { kind: "vocal"; baseline: number; peak: number }
  | { kind: "flicker"; baseline: number; peak: number; rate?: number }
  // Beacon-style on/off cycle. baseline = off intensity, peak = added
  // during the on phase. phaseMs offsets the cycle so multiple
  // beacons don't strobe in lockstep.
  | {
      kind: "blink";
      baseline: number;
      peak: number;
      onMs: number;
      offMs: number;
      phaseMs?: number;
    };

interface OrbThrusterConfig {
  // Unit-ish vector in model space along which exhaust travels. Will
  // be normalized at runtime, so any non-zero magnitude works.
  direction: readonly [number, number, number];
  // Particle count. Higher = denser plume, more CPU per frame.
  count: number;
  // Particle lifetime in ms before respawn.
  lifetime: number;
  // Initial random spread (sphere radius around the origin).
  spread: number;
  // Travel speed in model units per second (slight per-particle jitter
  // is added on top so the plume isn't a uniform front).
  speed: number;
  // Sprite size in pixels (constant on screen — no distance scaling
  // since the model sits at fixed camera radius).
  size: number;
  // Half-angle (radians) of the cone particles emit into. 0 = perfect
  // column. ~0.4 fans them into a visible jet. Crank for big sprays.
  coneAngle?: number;
  // Optional override for the leading colour. Defaults to the light's
  // colour. End colour is leading × 0.2 unless `colorEnd` is given.
  colorStart?: number;
  colorEnd?: number;
}

interface OrbLightConfig {
  color: number;
  intensity: number; // initial / static value
  position: readonly [number, number, number];
  distance: number;
  decay?: number; // defaults to 2 (physically correct)
  animation?: OrbLightAnimation; // defaults to static
  // Optional particle thruster — additive Points stream emitted from
  // the light's position along `direction`. Cheap per-frame CPU update
  // (positions + ages mutated in-place) plus a tiny custom shader for
  // per-particle alpha + colour fade.
  thruster?: OrbThrusterConfig;
  // Optional visible "glow" source — without this a PointLight is
  // invisible, you only see its spill on surrounding surfaces. The
  // glow is a small additive-blended sphere at the light's position
  // (with an optional softer halo around it) and its opacity tracks
  // the light's intensity, so blinks / flickers also pulse the glow.
  glow?: {
    // Core orb radius (model units). Keep small — most of the visual
    // weight comes from the additive blend, not the geometry.
    size: number;
    // Max opacity at full intensity. Lower = subtler.
    opacity?: number;
    // Optional halo: a larger, dimmer sphere around the core. Same
    // colour, additive, smaller opacity. Sells the "glowing source"
    // look without needing post-process bloom.
    haloSize?: number;
    haloOpacity?: number;
    // Floor for glow visibility, 0..1. By default the glow tracks
    // light intensity directly, so a light at baseline=0 makes the
    // glow disappear between flashes. Setting idleLevel keeps the
    // glow at this fraction of its full opacity even when the light
    // is fully off — useful for beacons whose source should stay
    // visible as a faint marker while the model spill turns off.
    idleLevel?: number;
  };
}

// Shared thruster presets — most jets share the same exhaust profile.
// All exhaust straight down (model-space -Y) for a hovering look; flip
// or per-thruster override `direction` if specific ones should fire
// elsewhere (e.g., rear thrusters pointing backward).
const SIDE_THRUSTER: OrbThrusterConfig = {
  // Default direction; per-thruster entries override below.
  direction: [0, -1, 0],
  count: 3000,
  lifetime: 320,
  spread: 0.008,
  speed: 0.55,
  size: 3,
  coneAngle: 0.35,
};
const CENTER_THRUSTER: OrbThrusterConfig = {
  direction: [0, -1, 0],
  count: 5000,
  lifetime: 380,
  spread: 0.012,
  speed: 0.6,
  size: 4,
  coneAngle: 0.45,
};

const ORB_LIGHTS: readonly OrbLightConfig[] = [
  // 0 — center mouth. Cyan-blue, talks with the audio.
  {
    color: 0x33bbff,
    intensity: 0.2,
    position: [0.367, -0.072, -0.008],
    distance: 0.085,
    animation: { kind: "vocal", baseline: 0.2, peak: 4 },
  },
  // 1 — right eye flicker. Cyan-blue to match the mouth ring.
  {
    color: 0x33bbff,
    intensity: 1.5,
    position: [0.327, -0.071, -0.198],
    distance: 0.040,
    animation: { kind: "flicker", baseline: 0.6, peak: 1.4, rate: 14 },
  },
  // 2 — left eye flicker.
  {
    color: 0x33bbff,
    intensity: 1.5,
    position: [0.328, -0.072, 0.185],
    distance: 0.040,
    animation: { kind: "flicker", baseline: 0.6, peak: 1.4, rate: 14 },
  },
  // 3 — left beacon blink. Cream/yellow probe colour, slow strobe.
  // Glow makes the source itself visible (not just its spill on the
  // model) so it reads as an actual blinking light.
  {
    color: 0xfff0a8,
    intensity: 0,
    position: [0.317, -0.175, -0.222],
    distance: 0.12,
    animation: {
      kind: "blink",
      baseline: 0,
      peak: 0.06,
      onMs: 250,
      offMs: 2200,
    },
    glow: { size: 0.003, opacity: 1.0, haloSize: 0.005, haloOpacity: 0.6, idleLevel: 0.5 },
  },
  // 4 — right beacon blink. Same colour + cycle, offset half a cycle
  // so the two beacons don't strobe in lockstep.
  {
    color: 0xfff0a8,
    intensity: 0,
    position: [0.319, -0.164, 0.208],
    distance: 0.12,
    animation: {
      kind: "blink",
      baseline: 0,
      peak: 0.06,
      onMs: 250,
      offMs: 2200,
      phaseMs: 1225,
    },
    glow: { size: 0.003, opacity: 1.0, haloSize: 0.005, haloOpacity: 0.6, idleLevel: 0.5 },
  },
  // 5 — left ear flicker. Tiny additive glow + halo so the source
  // itself reads as a glowing dot against the side of the head.
  {
    color: 0x33bbff,
    intensity: 1.5,
    position: [0.078, -0.052, 0.358],
    distance: 0.020,
    animation: { kind: "flicker", baseline: 0.6, peak: 1.4, rate: 14 },
    glow: { size: 0.008, opacity: 0.95, haloSize: 0.020, haloOpacity: 0.35 },
  },
  // 6 — right ear flicker.
  {
    color: 0x33bbff,
    intensity: 1.5,
    position: [0.080, -0.059, -0.370],
    distance: 0.020,
    animation: { kind: "flicker", baseline: 0.6, peak: 1.4, rate: 14 },
    glow: { size: 0.008, opacity: 0.95, haloSize: 0.020, haloOpacity: 0.35 },
  },
  // 7 — top beacon blink. Sits inside the model, so a PointLight only
  // does so much (geometry above is hit by the upward-facing surface,
  // but the visible "lens" texture won't actually glow because point
  // lights don't drive emissive textures). For a proper beacon we
  // should modulate the matching material's emissive factor at
  // runtime — that's a TODO once we know the material name in the GLB.
  {
    color: 0xfff0a8,
    intensity: 0,
    position: [-0.036, 0.280, -0.154],
    distance: 0.065,
    animation: {
      kind: "blink",
      baseline: 0.2,
      peak: 2.4,
      onMs: 200,
      offMs: 900,
      phaseMs: 340,
    },
  },
  // 8 — left front thruster. Bright cyan-white, jet-style flicker.
  // Aim baked from pitch=0.450 yaw=3.875 (tuned in dev mode).
  {
    color: 0x66ddff,
    intensity: 1.5,
    position: [0.137, -0.389, 0.190],
    distance: 0.020,
    animation: { kind: "flicker", baseline: 0.8, peak: 1.4, rate: 26 },
    thruster: { ...SIDE_THRUSTER, direction: [0.291, -0.900, 0.323] },
  },
  // 9 — right front thruster. pitch=0.500 yaw=-0.725.
  {
    color: 0x66ddff,
    intensity: 1.5,
    position: [0.134, -0.391, -0.197],
    distance: 0.020,
    animation: { kind: "flicker", baseline: 0.8, peak: 1.4, rate: 26 },
    thruster: { ...SIDE_THRUSTER, direction: [0.318, -0.878, -0.359] },
  },
  // 10 — center front thruster (larger / steadier than the side pair).
  // pitch=0.300 yaw=-1.450.
  {
    color: 0x66ddff,
    intensity: 1.5,
    position: [0.146, -0.446, -0.005],
    distance: 0.035,
    animation: { kind: "flicker", baseline: 1.0, peak: 1.2, rate: 22 },
    thruster: { ...CENTER_THRUSTER, direction: [0.293, -0.955, -0.036] },
  },
  // 11 — bottom-center thruster (between front and rear, lower y).
  // Left untuned: aims straight down.
  {
    color: 0x66ddff,
    intensity: 1.5,
    position: [-0.010, -0.461, -0.007],
    distance: 0.035,
    animation: { kind: "flicker", baseline: 1.0, peak: 1.2, rate: 22 },
    thruster: CENTER_THRUSTER,
  },
  // 12 — rear left thruster. pitch=0.450 yaw=2.525.
  {
    color: 0x66ddff,
    intensity: 1.5,
    position: [-0.162, -0.391, 0.191],
    distance: 0.020,
    animation: { kind: "flicker", baseline: 0.8, peak: 1.4, rate: 26 },
    thruster: { ...SIDE_THRUSTER, direction: [-0.252, -0.900, 0.355] },
  },
  // 13 — rear center thruster. pitch=0.375 yaw=1.525.
  {
    color: 0x66ddff,
    intensity: 1.5,
    position: [-0.166, -0.415, -0.006],
    distance: 0.020,
    animation: { kind: "flicker", baseline: 0.8, peak: 1.4, rate: 26 },
    thruster: { ...SIDE_THRUSTER, direction: [-0.366, -0.931, -0.017] },
  },
  // 14 — rear right thruster. pitch=0.325 yaw=2.275. Z mirrored
  // negative so it sits opposite the rear-left (#12) instead of
  // stacking on the same side — direction's z mirrored too.
  {
    color: 0x66ddff,
    intensity: 1.5,
    position: [-0.160, -0.386, -0.193],
    distance: 0.020,
    animation: { kind: "flicker", baseline: 0.8, peak: 1.4, rate: 26 },
    thruster: { ...SIDE_THRUSTER, direction: [-0.243, -0.948, -0.207] },
  },
];

// Initial light index for click + WASD tuning. Use ',' / '.' keys at
// runtime to cycle through other lights without rebuilding.
const DEBUG_TUNE_INDEX = 3;

// Floating helper orb + speech-bubble pair. Tracks the spotlit element
// via lookAtSelector. The orb sits adjacent to the target on whichever
// horizontal side has room; the bubble drops diagonally away (vertically
// opposite from the target as well) so it never sits on or beside the
// thing the player is supposed to be reading.
//
// Falls back to bottom-left of the viewport when no target is set.

export interface TutorialHelperProps {
  title: string;
  body: ReactNode;
  lookAtSelector?: string | null;
  onAdvance?: () => void;
  advanceLabel?: string;
  onSkip?: () => void;
  skipLabel?: string;
  onDismiss?: () => void;
  dismissLabel?: string;
  neutralSkip?: boolean;
  // Where to anchor the orb when there's no spotlit element. Default
  // "center" works for intro / transition / farewell stops where the
  // orb is the only thing on screen. "bottom-right" / "bottom-left" pin
  // to a corner — useful when something else (e.g. the new-game modal)
  // already owns the centre and the orb shouldn't cover it. Pick the
  // side opposite the modal's CTA so the orb doesn't sit on top of the
  // buttons the player needs to click.
  fallbackPlacement?: "center" | "bottom-right" | "bottom-left";
  // Optional voice playback handles. When provided, the bubble renders
  // a mute + replay control row, AND the orb's mouth light is driven
  // from the live RMS readout exposed via audioControls.vocalVolume.
  // Audio is owned by useTutorialAudio upstream; the helper only
  // dispatches the toggles and polls the volume ref each frame.
  audioControls?: TutorialAudioControls;
}

interface Placement {
  positioned: boolean;
  orbTop: number;
  orbLeft: number;
  bubbleTop: number;
  bubbleLeft: number;
}

const UNPOSITIONED: Placement = {
  positioned: false,
  orbTop: 0,
  orbLeft: 0,
  bubbleTop: 0,
  bubbleLeft: 0,
};

const ORB_GAP = 23; // target → orb edge
// Negative: the bubble overlaps the orb. The model body sits in the
// upper portion of its (now taller) container, with the lower portion
// holding the thruster particle plumes. The overlap pushes the
// bubble's top edge up just enough that the very tail of the plumes
// disappears under the card — sells the "perched on top of the
// bubble" look while leaving most of the thrusters visible above.
const BUBBLE_GAP = -50;
// Shifts the orb vertically relative to its target's center. Negative
// nudges him upward. With thrusters extending the visible content
// further below the silhouette, we shift further up so the body
// (rather than the plume tail) ends up centered on the target.
const ORB_Y_OFFSET = -60;
const EDGE_MARGIN = 16; // viewport edge buffer

const ORB_FALLBACK_W = 240;
const ORB_FALLBACK_H = 324;
const BUBBLE_FALLBACK_W = 320;
const BUBBLE_FALLBACK_H = 110;

export function TutorialHelper({
  title,
  body,
  lookAtSelector,
  onAdvance,
  advanceLabel = "Got it",
  onSkip,
  skipLabel = "Skip",
  onDismiss,
  dismissLabel = "Skip tutorial",
  neutralSkip = false,
  fallbackPlacement = "center",
  audioControls,
}: TutorialHelperProps) {
  // Stable ref so the light-update rAF (mounted once) always reads
  // the latest controls without re-subscribing on prop swaps.
  const audioControlsRef = useRef(audioControls);
  audioControlsRef.current = audioControls;
  // All orb lights in ORB_LIGHTS order. Created on model load,
  // disposed on unmount. The animation rAF walks this list and updates
  // any with a non-static animation kind.
  const lightsRef = useRef<PointLight[]>([]);
  // Per-light flicker state, parallel to lightsRef. Null entries for
  // lights that don't flicker so iteration is just a null-check.
  const flickerStateRef = useRef<
    Array<{ current: number; target: number; nextSampleMs: number } | null>
  >([]);
  // Glow meshes parallel to lightsRef. Each entry is null (no glow
  // configured), a single core mesh, or a [core, halo] pair when the
  // config includes a halo.
  const glowsRef = useRef<Array<Mesh[] | null>>([]);
  // Currently-focused light for WASD/click tuning. Mutated by the
  // ',' / '.' cycle keys; both the WASD handler and the click-to-log
  // handler read this so cycling works across both effects.
  const tuneLightIndexRef = useRef<number>(DEBUG_TUNE_INDEX);
  // Particle thrusters parallel to lightsRef. Null when no thruster
  // configured. Each runtime owns the Points object plus the typed
  // arrays it writes into each frame.
  const thrustersRef = useRef<
    Array<{
      points: Points;
      geometry: BufferGeometry;
      material: ShaderMaterial;
      positions: Float32Array;
      ages: Float32Array;
      // Per-particle velocity (model-units per second). We store a
      // full 3-vector per particle so each can fly along its own cone
      // ray without re-deriving the basis each frame.
      velocities: Float32Array;
      origin: readonly [number, number, number];
      // Forward axis of the cone, plus two perpendicular axes used at
      // spawn time to pick a random ray inside the cone. Mutable so
      // the dev tilt controls can rewrite them without rebuilding the
      // particle system.
      forward: [number, number, number];
      right: [number, number, number];
      up: [number, number, number];
      cfg: OrbThrusterConfig;
    } | null>
  >([]);
  // Debug marker (small green sphere) tracking the actively-tuned
  // light. Lifted to component scope so the click-to-log effect (and
  // the cycle keys) can move it in lockstep with WASD nudging.
  const markerRef = useRef<Mesh | null>(null);
  const orbRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  // Stable ref so the rAF loop (mounted once) can read the latest
  // selector without re-subscribing on every prop change.
  const lookAtRef = useRef<string | null | undefined>(lookAtSelector);
  lookAtRef.current = lookAtSelector;
  const [placement, setPlacement] = useState<Placement>(UNPOSITIONED);

  useLayoutEffect(() => {
    if (!lookAtSelector) {
      // No spotlit element — anchor based on fallbackPlacement. "center"
      // works for intro / transition / farewell stops where the orb is
      // the only thing on screen. "bottom-right" pins to a corner so it
      // doesn't fight a centered modal (e.g. the new-game wizard).
      const measureCenter = () => {
        const orbEl = orbRef.current;
        const bubbleEl = bubbleRef.current;
        if (!orbEl || !bubbleEl) return;
        const orbRect = orbEl.getBoundingClientRect();
        const bubbleRect = bubbleEl.getBoundingClientRect();
        const orbW = orbRect.width || ORB_FALLBACK_W;
        const orbH = orbRect.height || ORB_FALLBACK_H;
        const bubbleW = bubbleRect.width || BUBBLE_FALLBACK_W;
        const bubbleH = bubbleRect.height || BUBBLE_FALLBACK_H;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Combined visual height accounts for the bubble overlapping
        // the orb (BUBBLE_GAP is negative).
        const totalH = orbH + bubbleH + BUBBLE_GAP;

        let orbLeft: number;
        let orbTop: number;
        let bubbleLeft: number;
        let bubbleTop: number;

        if (fallbackPlacement === "bottom-right" || fallbackPlacement === "bottom-left") {
          // Pinned to a bottom corner with the bubble extending upward
          // (orb-on-bottom, bubble-on-top). The whole stack stays out
          // of the centred modal's footprint and sits opposite the
          // modal's CTA buttons.
          const margin = 28;
          if (fallbackPlacement === "bottom-right") {
            orbLeft = vw - orbW - margin;
            bubbleLeft = vw - bubbleW - margin;
          } else {
            orbLeft = margin;
            bubbleLeft = margin;
          }
          orbTop = vh - orbH - margin;
          bubbleTop = orbTop - bubbleH - BUBBLE_GAP;
        } else {
          // Centered: orb above, bubble overlapping below, both centred
          // horizontally on the viewport.
          orbLeft = (vw - orbW) / 2;
          orbTop = (vh - totalH) / 2;
          bubbleLeft = (vw - bubbleW) / 2;
          bubbleTop = orbTop + orbH + BUBBLE_GAP;
        }

        setPlacement(prev => {
          if (
            prev.positioned &&
            Math.abs(prev.orbTop - orbTop) < 0.5 &&
            Math.abs(prev.orbLeft - orbLeft) < 0.5 &&
            Math.abs(prev.bubbleTop - bubbleTop) < 0.5 &&
            Math.abs(prev.bubbleLeft - bubbleLeft) < 0.5
          ) return prev;
          return { positioned: true, orbTop, orbLeft, bubbleTop, bubbleLeft };
        });
      };
      measureCenter();
      window.addEventListener("resize", measureCenter);
      let resizeObs: ResizeObserver | null = null;
      if (typeof ResizeObserver !== "undefined") {
        resizeObs = new ResizeObserver(measureCenter);
        if (orbRef.current) resizeObs.observe(orbRef.current);
        if (bubbleRef.current) resizeObs.observe(bubbleRef.current);
      }
      return () => {
        window.removeEventListener("resize", measureCenter);
        resizeObs?.disconnect();
      };
    }

    const measure = () => {
      const orbEl = orbRef.current;
      const bubbleEl = bubbleRef.current;
      if (!orbEl || !bubbleEl) return;
      let target: HTMLElement | null = null;
      try {
        target = document.querySelector<HTMLElement>(lookAtSelector);
      } catch {
        target = null;
      }
      if (!target) {
        setPlacement(UNPOSITIONED);
        return;
      }
      const t = target.getBoundingClientRect();
      const orbRect = orbEl.getBoundingClientRect();
      const bubbleRect = bubbleEl.getBoundingClientRect();
      const orbW = orbRect.width || ORB_FALLBACK_W;
      const orbH = orbRect.height || ORB_FALLBACK_H;
      const bubbleW = bubbleRect.width || BUBBLE_FALLBACK_W;
      const bubbleH = bubbleRect.height || BUBBLE_FALLBACK_H;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Horizontal: pick whichever side has room for max(orb, bubble).
      // The bubble is wider than the orb, so we need to fit it past
      // where the orb sits. Fall back to whichever side has more space
      // even if it's tight — clamping below keeps everything visible.
      const requiredW = Math.max(orbW, bubbleW);
      const rightSpace = vw - t.right - ORB_GAP - EDGE_MARGIN;
      const leftSpace = t.left - ORB_GAP - EDGE_MARGIN;
      let horiz: "right" | "left";
      if (rightSpace >= requiredW) horiz = "right";
      else if (leftSpace >= requiredW) horiz = "left";
      else horiz = rightSpace >= leftSpace ? "right" : "left";

      // Orb: adjacent to target on chosen horizontal side, vertically
      // centered on target. Clamp into viewport so it stays visible
      // even if the target itself is partially offscreen.
      let orbLeft =
        horiz === "right" ? t.right + ORB_GAP : t.left - ORB_GAP - orbW;
      let orbTop = t.top + t.height / 2 - orbH / 2 + ORB_Y_OFFSET;
      orbLeft = Math.max(
        EDGE_MARGIN,
        Math.min(vw - orbW - EDGE_MARGIN, orbLeft),
      );
      orbTop = Math.max(EDGE_MARGIN, Math.min(vh - orbH - EDGE_MARGIN, orbTop));

      // Vertical: bubble drops to the side of the orb with more room,
      // which naturally points away from the target since the orb sits
      // at the target's vertical level.
      const orbBottom = orbTop + orbH;
      const belowSpace = vh - orbBottom - BUBBLE_GAP - EDGE_MARGIN;
      const aboveSpace = orbTop - BUBBLE_GAP - EDGE_MARGIN;
      const vert: "below" | "above" =
        belowSpace >= aboveSpace ? "below" : "above";

      // Bubble: stacked above/below orb. Horizontally aligned so it
      // extends past the orb in the same direction the orb sits relative
      // to target — h=right means bubble's LEFT edge tracks orb's left
      // (extends rightward); h=left means bubble's RIGHT edge tracks
      // orb's right (extends leftward).
      let bubbleLeft = horiz === "right" ? orbLeft : orbLeft + orbW - bubbleW;
      let bubbleTop =
        vert === "below"
          ? orbBottom + BUBBLE_GAP
          : orbTop - BUBBLE_GAP - bubbleH;
      bubbleLeft = Math.max(
        EDGE_MARGIN,
        Math.min(vw - bubbleW - EDGE_MARGIN, bubbleLeft),
      );
      bubbleTop = Math.max(
        EDGE_MARGIN,
        Math.min(vh - bubbleH - EDGE_MARGIN, bubbleTop),
      );

      setPlacement((prev) => {
        if (
          prev.positioned &&
          Math.abs(prev.orbTop - orbTop) < 0.5 &&
          Math.abs(prev.orbLeft - orbLeft) < 0.5 &&
          Math.abs(prev.bubbleTop - bubbleTop) < 0.5 &&
          Math.abs(prev.bubbleLeft - bubbleLeft) < 0.5
        )
          return prev;
        return { positioned: true, orbTop, orbLeft, bubbleTop, bubbleLeft };
      });
    };

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    const root = document.querySelector(".app") ?? document.body;
    const observer = new MutationObserver(measure);
    observer.observe(root, {
      subtree: true,
      childList: true,
      attributes: true,
    });

    let resize: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resize = new ResizeObserver(measure);
      if (orbRef.current) resize.observe(orbRef.current);
      if (bubbleRef.current) resize.observe(bubbleRef.current);
    }

    const interval = window.setInterval(measure, 250);

    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      observer.disconnect();
      resize?.disconnect();
      window.clearInterval(interval);
    };
  }, [lookAtSelector, title, fallbackPlacement]);

  // Spawn a coloured point light at the orb's face once the model is
  // loaded. Attached to the ModelScene's `target` (the model's pivot)
  // so it moves with him as the camera orbits — model-viewer applies
  // the camera transform to the parent, leaving the light glued to the
  // face in model space. The face is an inset ring; lighting it from
  // just outside makes the concave surface read as a glowing rim.
  useEffect(() => {
    const orbEl = orbRef.current;
    const modelEl = orbEl?.querySelector("model-viewer") as
      | (HTMLElement & {
          loaded?: boolean;
          [$scene]?: {
            target: { add: (o: PointLight | Mesh) => void };
            queueRender: () => void;
          };
        })
      | null;
    if (!modelEl) return;

    // DEBUG: flip to true when placing a new light. Enables:
    //   - green marker sphere at the light's position
    //   - cyan wireframe sphere showing the falloff radius
    //   - click-to-log effect that prints face coords + normal
    //   - WASD/QE keys to nudge position, [/] to nudge distance
    // Pair with FREEZE_HEAD (rAF effect below) and FAKE_TALK (in
    // this effect) for easier eyeballing while tuning.
    const DEBUG_LIGHT_TUNING = false;

    // Aliased through refs so the click-to-log effect can update them.
    let marker: Mesh | null = null;

    const attach = () => {
      const scene = modelEl[$scene];
      if (!scene || lightsRef.current.length) return;

      // Spawn one PointLight per ORB_LIGHTS entry, in order. Static
      // animations bake their intensity here and never change again;
      // dynamic ones get their initial value from cfg.intensity and
      // the per-frame loop overwrites it.
      const lights: PointLight[] = [];
      for (const cfg of ORB_LIGHTS) {
        const light = new PointLight(
          cfg.color,
          cfg.intensity,
          cfg.distance,
          cfg.decay ?? 2,
        );
        light.position.set(...cfg.position);
        scene.target.add(light);
        lights.push(light);
      }
      lightsRef.current = lights;
      flickerStateRef.current = ORB_LIGHTS.map(cfg =>
        cfg.animation?.kind === "flicker"
          ? { current: cfg.animation.baseline, target: cfg.animation.baseline, nextSampleMs: 0 }
          : null,
      );

      // Build particle thrusters for any light whose config opts in.
      thrustersRef.current = ORB_LIGHTS.map(cfg => {
        if (!cfg.thruster) return null;
        const t = cfg.thruster;

        // Normalize forward + build perpendicular basis once. Used to
        // pick a random ray inside the emission cone at spawn time.
        const [fxR, fyR, fzR] = t.direction;
        const fmag = Math.hypot(fxR, fyR, fzR) || 1;
        const forward: [number, number, number] = [
          fxR / fmag,
          fyR / fmag,
          fzR / fmag,
        ];
        // Pick an "any" axis not parallel to forward, then cross to
        // get a perpendicular, then cross again for the third axis.
        const helper: readonly [number, number, number] =
          Math.abs(forward[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
        const rxR = forward[1] * helper[2] - forward[2] * helper[1];
        const ryR = forward[2] * helper[0] - forward[0] * helper[2];
        const rzR = forward[0] * helper[1] - forward[1] * helper[0];
        const rmag = Math.hypot(rxR, ryR, rzR) || 1;
        const right: [number, number, number] = [
          rxR / rmag,
          ryR / rmag,
          rzR / rmag,
        ];
        const up: [number, number, number] = [
          forward[1] * right[2] - forward[2] * right[1],
          forward[2] * right[0] - forward[0] * right[2],
          forward[0] * right[1] - forward[1] * right[0],
        ];

        const cone = t.coneAngle ?? 0.3;
        const positions = new Float32Array(t.count * 3);
        const ages = new Float32Array(t.count);
        const velocities = new Float32Array(t.count * 3);

        // Sample a ray inside the cone, scaled to per-particle speed.
        const sampleVelocity = (out: Float32Array, oi: number) => {
          // Uniform-on-disc projected to cone half-angle. theta is
          // cone polar angle, phi is azimuth around forward.
          const theta = Math.random() * cone;
          const phi = Math.random() * Math.PI * 2;
          const sx = Math.sin(theta) * Math.cos(phi);
          const sy = Math.sin(theta) * Math.sin(phi);
          const cz = Math.cos(theta);
          const speed = t.speed * (0.7 + Math.random() * 0.3);
          out[oi] = (right[0] * sx + up[0] * sy + forward[0] * cz) * speed;
          out[oi + 1] = (right[1] * sx + up[1] * sy + forward[1] * cz) * speed;
          out[oi + 2] = (right[2] * sx + up[2] * sy + forward[2] * cz) * speed;
        };

        // Pre-spawn: each particle gets a random initial age + a
        // velocity sampled from the cone, then is advanced along its
        // own ray by its age fraction so the plume looks pre-populated.
        for (let i = 0; i < t.count; i++) {
          const ang = Math.random() * Math.PI * 2;
          const phi = Math.acos(2 * Math.random() - 1);
          const r = Math.cbrt(Math.random()) * t.spread;
          positions[i * 3] = cfg.position[0] + r * Math.sin(phi) * Math.cos(ang);
          positions[i * 3 + 1] = cfg.position[1] + r * Math.sin(phi) * Math.sin(ang);
          positions[i * 3 + 2] = cfg.position[2] + r * Math.cos(phi);
          ages[i] = Math.random();
          sampleVelocity(velocities, i * 3);
          const dt = (ages[i] * t.lifetime) / 1000;
          positions[i * 3] += velocities[i * 3] * dt;
          positions[i * 3 + 1] += velocities[i * 3 + 1] * dt;
          positions[i * 3 + 2] += velocities[i * 3 + 2] * dt;
        }

        const geometry = new BufferGeometry();
        const posAttr = new BufferAttribute(positions, 3);
        posAttr.usage = DynamicDrawUsage;
        geometry.setAttribute("position", posAttr);
        const ageAttr = new BufferAttribute(ages, 1);
        ageAttr.usage = DynamicDrawUsage;
        geometry.setAttribute("age", ageAttr);

        const start = new Color(t.colorStart ?? cfg.color);
        const end = new Color(
          t.colorEnd ?? new Color(cfg.color).multiplyScalar(0.2).getHex(),
        );
        const material = new ShaderMaterial({
          uniforms: {
            colorStart: { value: start },
            colorEnd: { value: end },
            pointSize: { value: t.size },
          },
          // Constant pixel size: the camera radius is fixed by the
          // model-viewer auto-frame, so distance attenuation just
          // adds a free knob nobody wants. Tune `size` directly.
          vertexShader: `
            attribute float age;
            varying float vAge;
            uniform float pointSize;
            void main() {
              vAge = age;
              gl_PointSize = pointSize;
              gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
          `,
          fragmentShader: `
            uniform vec3 colorStart;
            uniform vec3 colorEnd;
            varying float vAge;
            void main() {
              vec2 c = gl_PointCoord - 0.5;
              float d = length(c);
              if (d > 0.5) discard;
              float falloff = smoothstep(0.5, 0.0, d);
              float alpha = falloff * (1.0 - vAge);
              vec3 col = mix(colorStart, colorEnd, vAge);
              gl_FragColor = vec4(col, alpha);
            }
          `,
          transparent: true,
          depthWrite: false,
          blending: AdditiveBlending,
        });

        const points = new Points(geometry, material);
        // Exclude from raycasts so click-to-log doesn't hit the plume.
        points.frustumCulled = false;
        scene.target.add(points);
        return {
          points,
          geometry,
          material,
          positions,
          ages,
          velocities,
          origin: cfg.position,
          forward,
          right,
          up,
          cfg: t,
        };
      });

      // Build glow meshes for any light whose config opts into one.
      // Additive blending + no depth write so the glow looks like
      // emitted light, not a solid object. depthTest stays on so
      // opaque geometry can still occlude (e.g. when the camera goes
      // behind the model).
      glowsRef.current = ORB_LIGHTS.map(cfg => {
        if (!cfg.glow) return null;
        const meshes: Mesh[] = [];
        const core = new Mesh(
          new SphereGeometry(cfg.glow.size, 16, 12),
          new MeshBasicMaterial({
            color: cfg.color,
            transparent: true,
            opacity: cfg.glow.opacity ?? 0.9,
            blending: AdditiveBlending,
            depthWrite: false,
          }),
        );
        core.position.set(...cfg.position);
        scene.target.add(core);
        meshes.push(core);
        if (cfg.glow.haloSize && cfg.glow.haloSize > 0) {
          const halo = new Mesh(
            new SphereGeometry(cfg.glow.haloSize, 24, 16),
            new MeshBasicMaterial({
              color: cfg.color,
              transparent: true,
              opacity: cfg.glow.haloOpacity ?? 0.3,
              blending: AdditiveBlending,
              depthWrite: false,
            }),
          );
          halo.position.set(...cfg.position);
          scene.target.add(halo);
          meshes.push(halo);
        }
        return meshes;
      });

      if (DEBUG_LIGHT_TUNING) {
        // Tiny unlit marker sphere at the active light's position so
        // we can see exactly where it sits while nudging. Uses
        // MeshBasicMaterial so it ignores scene lighting and stays
        // visibly green regardless of what's around it.
        const tuneTarget = lights[DEBUG_TUNE_INDEX];
        if (tuneTarget) {
          marker = new Mesh(
            new SphereGeometry(0.008, 12, 12),
            new MeshBasicMaterial({ color: 0x00ff00 }),
          );
          marker.position.copy(tuneTarget.position);
          scene.target.add(marker);
          markerRef.current = marker;
        }
      }

      // Apply tune visibility now that the thruster runtime exists.
      // No-op when DEBUG_LIGHT_TUNING is off.
      applyTuneVisibility();

      scene.queueRender();
    };

    // DEBUG: fake-talk strobe — bursts of "syllables" with brief
    // pauses, mimicking the envelope of speech so we can see how the
    // light reads in motion before wiring up real audio analysis.
    // Flip to true to demo the talking effect without an audio source.
    const FAKE_TALK = false;
    let fakeRaf = 0;
    if (FAKE_TALK) {
      type Phase = "speak" | "pause";
      let phase: Phase = "speak";
      let phaseEnd = performance.now() + 300 + Math.random() * 400;
      const fakeTick = () => {
        const now = performance.now();
        if (now > phaseEnd) {
          phase = phase === "speak" ? "pause" : "speak";
          phaseEnd =
            now +
            (phase === "speak"
              ? 250 + Math.random() * 600
              : 300 + Math.random() * 500);
        }
        let v: number;
        if (phase === "speak") {
          // Two oscillators at different rates + jitter approximate
          // the rough rise/fall of syllables without sounding metronomic.
          const a = Math.abs(Math.sin(now * 0.022));
          const b = Math.abs(Math.sin(now * 0.041 + 1.7));
          v = Math.min(1, 0.35 + 0.5 * a * b + 0.18 * Math.random());
        } else {
          v = 0.05 * Math.random();
        }
        // Drive any vocal-animated light from the synthetic envelope.
        for (let i = 0; i < ORB_LIGHTS.length; i++) {
          const cfg = ORB_LIGHTS[i];
          if (cfg.animation?.kind !== "vocal") continue;
          const light = lightsRef.current[i];
          if (light) light.intensity = cfg.animation.baseline + v * cfg.animation.peak;
        }
        modelEl[$scene]?.queueRender();
        fakeRaf = requestAnimationFrame(fakeTick);
      };
      fakeRaf = requestAnimationFrame(fakeTick);
    }

    // Indices into ORB_LIGHTS that have a thruster — used for N/B
    // cycling. Computed once; entries don't move at runtime.
    const thrusterIndices: number[] = [];
    for (let i = 0; i < ORB_LIGHTS.length; i++) {
      if (ORB_LIGHTS[i].thruster) thrusterIndices.push(i);
    }
    // Per-thruster pitch/yaw, applied to a (0,-1,0) base. Bake the
    // resulting direction into the config when you're happy.
    const thrusterAngles = new Map<number, { pitch: number; yaw: number }>();
    let tunePos = 0; // index within thrusterIndices

    // While DEBUG_LIGHT_TUNING is on, hide every thruster except the
    // one we're currently aiming and crank its size + colour so it's
    // unmissable. Restored when N/B switches the active index. When
    // tuning is off this is a no-op so production renders all of them.
    const TUNE_SIZE_BOOST = 1.8;
    const TUNE_COLOR_BOOST = 1.7;
    const applyTuneVisibility = () => {
      if (!DEBUG_LIGHT_TUNING) return;
      const activeIdx = thrusterIndices[tunePos];
      for (let i = 0; i < thrustersRef.current.length; i++) {
        const th = thrustersRef.current[i];
        if (!th) continue;
        const isActive = i === activeIdx;
        th.points.visible = isActive;
        th.material.uniforms.pointSize.value =
          th.cfg.size * (isActive ? TUNE_SIZE_BOOST : 1);
        const lightColor = ORB_LIGHTS[i].color;
        const start = new Color(th.cfg.colorStart ?? lightColor);
        const end = new Color(
          th.cfg.colorEnd ?? new Color(lightColor).multiplyScalar(0.2).getHex(),
        );
        if (isActive) {
          start.multiplyScalar(TUNE_COLOR_BOOST);
          end.multiplyScalar(TUNE_COLOR_BOOST);
        }
        (th.material.uniforms.colorStart.value as Color).copy(start);
        (th.material.uniforms.colorEnd.value as Color).copy(end);
      }
      modelEl[$scene]?.queueRender();
    };

    // Rebuild a thruster's basis from a (mostly-arbitrary) direction.
    // Mutates the existing forward/right/up tuples in place so live
    // particles keep moving along their old velocity until they
    // respawn — gives a smooth transition.
    const setThrusterDir = (
      idx: number,
      dx: number,
      dy: number,
      dz: number,
    ) => {
      const th = thrustersRef.current[idx];
      if (!th) return;
      const m = Math.hypot(dx, dy, dz) || 1;
      th.forward[0] = dx / m;
      th.forward[1] = dy / m;
      th.forward[2] = dz / m;
      const helper: [number, number, number] =
        Math.abs(th.forward[1]) > 0.95 ? [1, 0, 0] : [0, 1, 0];
      const rxR = th.forward[1] * helper[2] - th.forward[2] * helper[1];
      const ryR = th.forward[2] * helper[0] - th.forward[0] * helper[2];
      const rzR = th.forward[0] * helper[1] - th.forward[1] * helper[0];
      const rmag = Math.hypot(rxR, ryR, rzR) || 1;
      th.right[0] = rxR / rmag;
      th.right[1] = ryR / rmag;
      th.right[2] = rzR / rmag;
      th.up[0] = th.forward[1] * th.right[2] - th.forward[2] * th.right[1];
      th.up[1] = th.forward[2] * th.right[0] - th.forward[0] * th.right[2];
      th.up[2] = th.forward[0] * th.right[1] - th.forward[1] * th.right[0];
    };

    // Convert (pitch, yaw) into a unit vector starting from (0, -1, 0).
    // Pitch around X, then yaw around Y. Both in radians.
    const dirFromAngles = (
      pitch: number,
      yaw: number,
    ): [number, number, number] => {
      const cP = Math.cos(pitch);
      const sP = Math.sin(pitch);
      // (0,-1,0) pitched around X: (0, -cP, -sP)
      const x0 = 0;
      const y0 = -cP;
      const z0 = -sP;
      const cY = Math.cos(yaw);
      const sY = Math.sin(yaw);
      // Yawed around Y
      return [x0 * cY + z0 * sY, y0, -x0 * sY + z0 * cY];
    };

    // Move marker + radius sphere onto whichever light is currently
    // focused for tuning. Called from the cycle keys below.
    const applyTuneFocus = () => {
      const idx = tuneLightIndexRef.current;
      const light = lightsRef.current[idx];
      if (!light) return;
      if (markerRef.current) markerRef.current.position.copy(light.position);
      modelEl[$scene]?.queueRender();
    };

    // DEBUG keyboard tuning.
    //
    //   Light placement (targets the light at tuneLightIndexRef):
    //     A/D = -X / +X     W/S = +Y / -Y     Q/E = -Z / +Z
    //     [ / ] = shrink / grow light.distance
    //     , / . = previous / next light (cycles tuneLightIndexRef)
    //     ; / ' = shrink / grow active light's glow size
    //
    //   Thruster aim (cycles through every light that has a thruster):
    //     N / B = next / previous thruster
    //     I / K = pitch  ↑ / ↓
    //     J / L = yaw    ← / →
    //
    // Shift on any key = 5× step. Logs the new value to console after
    // each press so you can copy it back into the source.
    const onKey = (e: KeyboardEvent) => {
      const stepPos = (e.shiftKey ? 0.025 : 0.005);
      const stepAng = e.shiftKey ? 0.1 : 0.025;
      const k = e.key.toLowerCase();

      // Thruster cycle / aim takes priority over light nudging when
      // it matches — those keys (i/j/k/l/n/b) don't overlap with WASD.
      if (k === "n" || k === "b") {
        e.preventDefault();
        if (!thrusterIndices.length) return;
        tunePos =
          k === "n"
            ? (tunePos + 1) % thrusterIndices.length
            : (tunePos - 1 + thrusterIndices.length) % thrusterIndices.length;
        const idx = thrusterIndices[tunePos];
        const a = thrusterAngles.get(idx) ?? { pitch: 0, yaw: 0 };
        applyTuneVisibility();
        console.log(
          `[thruster] tuning #${idx} (${tunePos + 1}/${thrusterIndices.length})  pitch=${a.pitch.toFixed(3)} yaw=${a.yaw.toFixed(3)}`,
        );
        return;
      }
      if (k === "i" || k === "j" || k === "k" || k === "l") {
        if (!thrusterIndices.length) return;
        const idx = thrusterIndices[tunePos];
        const a = thrusterAngles.get(idx) ?? { pitch: 0, yaw: 0 };
        if (k === "i") a.pitch += stepAng;
        else if (k === "k") a.pitch -= stepAng;
        else if (k === "j") a.yaw -= stepAng;
        else if (k === "l") a.yaw += stepAng;
        thrusterAngles.set(idx, a);
        e.preventDefault();
        const [dx, dy, dz] = dirFromAngles(a.pitch, a.yaw);
        setThrusterDir(idx, dx, dy, dz);
        console.log(
          `[thruster ${idx}] pitch=${a.pitch.toFixed(3)} yaw=${a.yaw.toFixed(3)}  direction: [${dx.toFixed(3)}, ${dy.toFixed(3)}, ${dz.toFixed(3)}]`,
        );
        modelEl[$scene]?.queueRender();
        return;
      }

      // Cycle the tuned light. ',' = previous, '.' = next.
      if (k === "," || k === ".") {
        e.preventDefault();
        const n = lightsRef.current.length;
        if (!n) return;
        const dir = k === "." ? 1 : -1;
        tuneLightIndexRef.current =
          (tuneLightIndexRef.current + dir + n) % n;
        applyTuneFocus();
        const idx = tuneLightIndexRef.current;
        const l = lightsRef.current[idx];
        console.log(
          `[orb light] tuning #${idx}  position=(${l.position.x.toFixed(3)}, ${l.position.y.toFixed(3)}, ${l.position.z.toFixed(3)})  distance=${l.distance.toFixed(3)}`,
        );
        return;
      }

      // Adjust the visible glow size of the active light. ';' shrinks,
      // "'" grows. Multiplier on the existing mesh scale, so logged
      // size accounts for prior nudges. No-op for lights without glow.
      if (k === ";" || k === "'") {
        e.preventDefault();
        const idx = tuneLightIndexRef.current;
        const glow = glowsRef.current[idx];
        const glowCfg = ORB_LIGHTS[idx]?.glow;
        if (!glow || !glowCfg) {
          console.log(`[orb glow ${idx}] no glow on this light`);
          return;
        }
        const factor = e.shiftKey ? 1.10 : 1.04;
        const mult = k === "'" ? factor : 1 / factor;
        for (const m of glow) m.scale.multiplyScalar(mult);
        const coreSize = glowCfg.size * (glow[0]?.scale.x ?? 1);
        const haloSize = (glowCfg.haloSize ?? 0) * (glow[1]?.scale.x ?? 1);
        console.log(
          `[orb glow ${idx}] core size=${coreSize.toFixed(4)}` +
            (haloSize ? `  halo size=${haloSize.toFixed(4)}` : ""),
        );
        modelEl[$scene]?.queueRender();
        return;
      }

      // Light placement keys.
      const idx = tuneLightIndexRef.current;
      const light = lightsRef.current[idx];
      if (!light) return;
      let dx = 0, dy = 0, dz = 0;
      let dr = 0;
      switch (k) {
        case "a": dx = -stepPos; break;
        case "d": dx = +stepPos; break;
        case "w": dy = +stepPos; break;
        case "s": dy = -stepPos; break;
        case "q": dz = -stepPos; break;
        case "e": dz = +stepPos; break;
        case "[": dr = -stepPos; break;
        case "]": dr = +stepPos; break;
        default: return;
      }
      e.preventDefault();
      if (dx || dy || dz) {
        light.position.x += dx;
        light.position.y += dy;
        light.position.z += dz;
        if (marker) marker.position.copy(light.position);
        // Glow meshes track the light too — otherwise the visible orb
        // gets left behind and only its illumination spill follows.
        const glow = glowsRef.current[idx];
        if (glow) {
          for (const m of glow) m.position.copy(light.position);
        }
        const p = light.position;
        console.log(
          `[orb light ${idx}] position (${p.x.toFixed(3)}, ${p.y.toFixed(3)}, ${p.z.toFixed(3)})`,
        );
      } else if (dr) {
        light.distance = Math.max(0.01, light.distance + dr);
        console.log(`[orb light ${idx}] distance ${light.distance.toFixed(3)}`);
      }
      modelEl[$scene]?.queueRender();
    };
    if (DEBUG_LIGHT_TUNING) window.addEventListener("keydown", onKey);

    if (modelEl.loaded) attach();
    else modelEl.addEventListener("load", attach, { once: true });

    return () => {
      modelEl.removeEventListener("load", attach);
      window.removeEventListener("keydown", onKey);
      if (fakeRaf) cancelAnimationFrame(fakeRaf);
      for (const light of lightsRef.current) {
        light.parent?.remove(light);
        light.dispose();
      }
      lightsRef.current = [];
      flickerStateRef.current = [];
      for (const meshes of glowsRef.current) {
        if (!meshes) continue;
        for (const mesh of meshes) {
          mesh.parent?.remove(mesh);
          mesh.geometry.dispose();
          (mesh.material as MeshBasicMaterial).dispose();
        }
      }
      glowsRef.current = [];
      for (const th of thrustersRef.current) {
        if (!th) continue;
        th.points.parent?.remove(th.points);
        th.geometry.dispose();
        th.material.dispose();
      }
      thrustersRef.current = [];
      if (marker) {
        marker.parent?.remove(marker);
        marker.geometry.dispose();
        (marker.material as MeshBasicMaterial).dispose();
        marker = null;
        markerRef.current = null;
      }
    };
  }, []);

  // Drive the light's intensity from the live audio analyser. Polled
  // imperatively in its own rAF so the analyser's per-frame writes
  // never churn the React reconciler. We also have to call
  // scene.queueRender() ourselves whenever the intensity moves —
  // model-viewer renders on demand, and the orbit loop only invalidates
  // the scene when cameraOrbit actually changes (it converges to a
  // steady value at .toFixed(1) precision, so once the cursor parks
  // the model-viewer goes quiet). Without an explicit queueRender we
  // see "stuck" frames lasting until the camera string moves again.
  useEffect(() => {
    const orbEl = orbRef.current;
    const modelEl = orbEl?.querySelector("model-viewer") as
      | (HTMLElement & { [$scene]?: { queueRender: () => void } })
      | null;
    let raf = 0;
    let lastTickMs = performance.now();
    // EMA blend factor for flicker — eases the random target each
    // frame so the light reads as flickering instead of strobing.
    const FLICKER_EASE = 0.35;
    const tick = () => {
      const v = Math.max(
        0,
        Math.min(1, audioControlsRef.current?.vocalVolume?.current ?? 0),
      );
      const lights = lightsRef.current;
      const flickers = flickerStateRef.current;
      const glows = glowsRef.current;
      const thrusters = thrustersRef.current;
      const now = performance.now();
      // Clamp dt to avoid teleporting particles after a tab-blur
      // catches us up with a multi-second frame.
      const dt = Math.min(64, now - lastTickMs);
      lastTickMs = now;
      // Walk all configured lights and dispatch on animation kind.
      // Static lights are baked at attach time and skipped here.
      let needsRender = false;
      for (let i = 0; i < lights.length; i++) {
        const cfg = ORB_LIGHTS[i];
        const anim = cfg?.animation;
        if (!anim || anim.kind === "static") continue;
        const light = lights[i];
        const before = light.intensity;
        if (anim.kind === "vocal") {
          light.intensity = anim.baseline + v * anim.peak;
        } else if (anim.kind === "flicker") {
          const state = flickers[i];
          if (!state) continue;
          if (now >= state.nextSampleMs) {
            state.target = anim.baseline + Math.random() * anim.peak;
            state.nextSampleMs = now + 1000 / (anim.rate ?? 20);
          }
          state.current += (state.target - state.current) * FLICKER_EASE;
          light.intensity = state.current;
        } else if (anim.kind === "blink") {
          // Deterministic on/off cycle from `now`; phaseMs offsets so
          // sibling beacons don't strobe in unison. Intensity eases
          // toward the binary target so the transition has a tiny
          // ramp instead of a hard pixel-flip.
          const cycle = anim.onMs + anim.offMs;
          const t = (now + (anim.phaseMs ?? 0)) % cycle;
          const isOn = t < anim.onMs;
          const target = anim.baseline + (isOn ? anim.peak : 0);
          light.intensity += (target - light.intensity) * 0.25;
        }
        // Threshold-gate render dirty-marking. 0.04 in intensity
        // units is below visible difference at our brightness range
        // and avoids a render every frame for sub-pixel changes.
        if (Math.abs(light.intensity - before) > 0.04) needsRender = true;

        // Pulse any associated glow meshes in lockstep with the
        // light's intensity. Normalize against the animation's max
        // (baseline + peak) so a fully-bright light = full glow.
        const glow = glows[i];
        if (glow && (anim.kind === "flicker" || anim.kind === "blink" || anim.kind === "vocal")) {
          const max = anim.baseline + anim.peak;
          const normalized = max > 0 ? Math.max(0, Math.min(1, light.intensity / max)) : 1;
          // Lerp from idleLevel to 1 as the light ramps from off to
          // peak — keeps the source visible at the configured floor
          // even when the light itself is fully dark.
          const idleLevel = cfg.glow!.idleLevel ?? 0;
          const effective = idleLevel + (1 - idleLevel) * normalized;
          for (let g = 0; g < glow.length; g++) {
            const mat = glow[g].material as MeshBasicMaterial;
            // g === 0 is the core, g === 1 is the halo. Pull each
            // mesh's "max opacity" from its config so the halo stays
            // proportionally dimmer.
            const baseOpacity =
              g === 0
                ? cfg.glow!.opacity ?? 0.9
                : cfg.glow!.haloOpacity ?? 0.3;
            mat.opacity = baseOpacity * effective;
          }
        }
      }
      // Step every active thruster: respawn dead particles, advance
      // live ones along their direction. CPU-bound but trivial — even
      // 5k particles is ~15µs per tick on modern hardware.
      const dtSec = dt / 1000;
      for (let i = 0; i < thrusters.length; i++) {
        const th = thrusters[i];
        if (!th) continue;
        const { positions, ages, velocities, origin, forward, right, up, cfg } = th;
        const lifetime = cfg.lifetime;
        const spread = cfg.spread;
        const cone = cfg.coneAngle ?? 0.3;
        const baseSpeed = cfg.speed;
        for (let p = 0; p < cfg.count; p++) {
          ages[p] += dt / lifetime;
          if (ages[p] >= 1) {
            // Respawn at origin with a random offset inside `spread`,
            // and pick a fresh velocity ray inside the emission cone.
            const ang = Math.random() * Math.PI * 2;
            const phi = Math.acos(2 * Math.random() - 1);
            const r = Math.cbrt(Math.random()) * spread;
            positions[p * 3] = origin[0] + r * Math.sin(phi) * Math.cos(ang);
            positions[p * 3 + 1] = origin[1] + r * Math.sin(phi) * Math.sin(ang);
            positions[p * 3 + 2] = origin[2] + r * Math.cos(phi);
            const theta = Math.random() * cone;
            const phi2 = Math.random() * Math.PI * 2;
            const sx = Math.sin(theta) * Math.cos(phi2);
            const sy = Math.sin(theta) * Math.sin(phi2);
            const cz = Math.cos(theta);
            const sp = baseSpeed * (0.7 + Math.random() * 0.3);
            velocities[p * 3] =
              (right[0] * sx + up[0] * sy + forward[0] * cz) * sp;
            velocities[p * 3 + 1] =
              (right[1] * sx + up[1] * sy + forward[1] * cz) * sp;
            velocities[p * 3 + 2] =
              (right[2] * sx + up[2] * sy + forward[2] * cz) * sp;
            // Carry excess age so spawn rate stays smooth across long
            // frames instead of bunching up at age 0.
            ages[p] = ages[p] - 1;
          } else {
            positions[p * 3] += velocities[p * 3] * dtSec;
            positions[p * 3 + 1] += velocities[p * 3 + 1] * dtSec;
            positions[p * 3 + 2] += velocities[p * 3 + 2] * dtSec;
          }
        }
        th.geometry.attributes.position.needsUpdate = true;
        th.geometry.attributes.age.needsUpdate = true;
        // Particle systems always change every frame, so always poke
        // the renderer when at least one thruster is active.
        needsRender = true;
      }

      if (needsRender) modelEl?.[$scene]?.queueRender();
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // DEV: click anywhere on the orb to log model-space coords + normal,
  // and snap the second light + its debug visuals to the click point
  // for fast placement. Pair with WASD/QE for fine-tuning afterwards.
  // The listener sits on the orb WRAPPER because the model-viewer's
  // pointer-events default to none (so clicks pass through to the UI
  // underneath in production). positionAndNormalFromPoint takes
  // screen coords, so it doesn't matter which element fires the event.
  // Flip to true when placing a new light or hotspot.
  const DEBUG_CLICK_TO_LOG_FACE = false;
  useEffect(() => {
    if (!DEBUG_CLICK_TO_LOG_FACE) return;
    const orbEl = orbRef.current;
    const modelEl = orbEl?.querySelector("model-viewer") as
      | (HTMLElement & {
          positionAndNormalFromPoint?: (
            x: number,
            y: number,
          ) => { position: { x: number; y: number; z: number }; normal: { x: number; y: number; z: number }; uv?: unknown } | null;
          [$scene]?: { queueRender: () => void };
        })
      | null;
    if (!orbEl || !modelEl) return;
    const onClick = (e: MouseEvent) => {
      const hit = modelEl.positionAndNormalFromPoint?.(e.clientX, e.clientY);
      if (!hit) {
        console.log("[orb hotspot] no hit at", e.clientX, e.clientY);
        return;
      }
      const fmt = (v: { x: number; y: number; z: number }) =>
        `${v.x.toFixed(3)} ${v.y.toFixed(3)} ${v.z.toFixed(3)}`;
      // Snap the actively-tuned light to the click — marker and any
      // glow meshes follow so the visuals stay in sync.
      const idx = tuneLightIndexRef.current;
      const light = lightsRef.current[idx];
      if (light) {
        light.position.set(hit.position.x, hit.position.y, hit.position.z);
        markerRef.current?.position.copy(light.position);
        const glow = glowsRef.current[idx];
        if (glow) {
          for (const m of glow) m.position.copy(light.position);
        }
        modelEl[$scene]?.queueRender();
      }
      console.log(
        `[orb hotspot] data-position="${fmt(hit.position)}" data-normal="${fmt(hit.normal)}"`,
      );
    };
    orbEl.addEventListener("click", onClick);
    return () => orbEl.removeEventListener("click", onClick);
  }, []);

  // Element-gaze + occasional forward glance. Runs once on mount;
  // reads the latest selector via ref so we never restart the rAF
  // loop. We orbit the *camera* around the model rather than rotating
  // the model itself, because the model's `orientation` setter
  // triggers ARRenderer.onUpdateScene which is
  // buggy in @google/model-viewer 4.x — it tries to add a menu panel
  // to a null presentedScene whenever the model rotates outside of an
  // active AR session. Camera orbits skip that path entirely.
  useEffect(() => {
    const orbEl = orbRef.current;
    // Resolve the model-viewer element from the DOM rather than the
    // ref — refs to custom elements in React 19 are supposed to work
    // but the typing is fragile. querySelector lands the live element
    // either way.
    const modelEl = orbEl?.querySelector("model-viewer") as
      | (HTMLElement & { cameraOrbit?: string })
      | null;
    if (!orbEl || !modelEl) return;

    // DEBUG: freeze the head so the user can click the face cleanly
    // while we dial in the light's position. Only the +90°/86° base
    // orbit (the GLB's forward-axis correction) is applied. Set back
    // to false once placement is locked.
    const FREEZE_HEAD = false;
    if (FREEZE_HEAD) {
      // Drop into orbit-controls mode: user can drag to rotate, scroll
      // to zoom, right-drag to pan. Initial pose is the +90°/86° base
      // so the GLB's forward axis is corrected before the player
      // grabs control. The disable-* attributes set in JSX are
      // removed at runtime so they don't fight the controls.
      modelEl.cameraOrbit = "90deg 86deg auto";
      modelEl.setAttribute("camera-controls", "");
      modelEl.removeAttribute("disable-zoom");
      modelEl.removeAttribute("disable-pan");
      modelEl.removeAttribute("disable-tap");
      // The default CSS sets pointer-events: none on the model so the
      // floating orb doesn't block underlying UI clicks. That also
      // swallows the drag events camera-controls needs — restore them
      // in dev mode. Click-to-log still fires because click events
      // bubble up to the wrapper.
      modelEl.style.pointerEvents = "auto";
      return;
    }

    // Vertical bob — driven from this rAF in model-space (translates
    // scene.target.position.y), so the whole orb hierarchy (model +
    // lights + particle systems) bobs together as genuine 3D motion
    // rather than a CSS transform on the wrapper. Honour
    // prefers-reduced-motion by skipping the offset entirely.
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Half the peak-to-peak excursion in model units. ~0.012 ≈ 1.2%
    // of a 1-unit model — close to the old 3px feel at 240px canvas.
    const BOB_AMPLITUDE = 0.012;
    const BOB_PERIOD_MS = 4200;
    const BOB_OMEGA = (2 * Math.PI) / BOB_PERIOD_MS;
    // Clear any leftover wrapper transform from prior CSS-bob runs
    // so the new 3D-native bob isn't double-applied alongside it.
    orbEl.style.transform = "";

    // Tracks whether the page is visible AND the window has focus.
    // When false, the gaze gives up on the spotlit element and falls
    // into a slow bored wander — the player isn't looking, so don't
    // pretend the orb is teaching anything.
    let pageActive =
      typeof document !== "undefined" &&
      !document.hidden &&
      document.hasFocus();
    let boredTheta = 0;
    let boredPhi = 0;
    let nextBoredChange = 0;
    // Camera orbit angles. theta = horizontal (azimuth), phi = vertical
    // (polar from up axis). Base theta is offset by +90° because the
    // GLB's forward axis points along its +X (screen-right) instead of
    // the conventional +Z, so the stock front-view shows him in profile.
    const BASE_THETA = 90;
    const BASE_PHI = 86;
    let currentTheta = BASE_THETA;
    let currentPhi = BASE_PHI;
    // Distraction state machine: idle → out → hold → back → idle.
    // Only meaningful when gazing at an element — periodically pulls
    // the gaze briefly forward to break the stare. When there's no
    // element the goal is already forward, so distractions are no-ops.
    let distractPhase: "idle" | "out" | "hold" | "back" = "idle";
    let phaseStart = 0;
    let nextDistraction = performance.now() + 25000 + Math.random() * 10000;
    let raf = 0;

    // Click-to-engage: clicking the orb overrides his gaze toward
    // the camera for a few seconds so he looks at the player directly.
    // Rapid-clicking 10× within 3s triggers an easter egg — first
    // time he does a wide head shake (looking around for who's
    // teasing him); again, and he goes the long way around to peer
    // behind himself. The level alternates so subsequent triggers
    // cycle between the two.
    const LOOK_AT_CAMERA_MS = 4000;
    const RAPID_CLICK_WINDOW_MS = 3000;
    const RAPID_CLICK_THRESHOLD = 10;
    type EasterStep = { atMs: number; theta: number; phi: number };
    // Wide look around — exaggerated left/right swing then a slow
    // head-shake before settling back on the camera.
    const EASTER_SHAKE: EasterStep[] = [
      { atMs: 0,    theta:  65, phi: 0 },  // wide left
      { atMs: 1100, theta: -65, phi: 0 },  // wide right
      { atMs: 2000, theta: -25, phi: 0 },  // slow shake
      { atMs: 2500, theta:  25, phi: 0 },
      { atMs: 3000, theta: -20, phi: 0 },
      { atMs: 3500, theta:  20, phi: 0 },
      { atMs: 4100, theta:   0, phi: 0 },  // home
    ];
    // Same opener, then he keeps going past right into "looking
    // behind himself", scans a bit, and comes back forward. All
    // beats stretched so the look-around feels deliberate.
    const EASTER_BEHIND: EasterStep[] = [
      { atMs: 0,    theta:  65, phi: 0 },   // wide left
      { atMs: 1100, theta: -65, phi: 0 },   // wide right
      { atMs: 2000, theta: -65, phi: 0 },   // pause right
      { atMs: 2700, theta: -65, phi: 0 },   // still pausing
      { atMs: 3300, theta: -110, phi: 0 },  // profile right
      { atMs: 4000, theta: -160, phi: 0 },  // behind-right
      { atMs: 4800, theta: -210, phi: 0 },  // swing to behind-left
      { atMs: 5600, theta: -160, phi: 0 },  // back to behind-right
      { atMs: 6400, theta: -90,  phi: 0 },  // unwind past profile
      { atMs: 7200, theta: 0,    phi: 0 },  // home, facing camera
    ];

    let lookAtCameraUntil = 0;
    let recentClicks: number[] = [];
    // 0 → next triple-click plays SHAKE, 1 → next plays BEHIND. Wraps.
    let easterLevel = 0;
    let easterPlayingFrom = 0;
    let easterPlayingSeq: EasterStep[] = [];

    const onOrbClick = () => {
      const now = performance.now();
      // Ignore clicks while an easter egg animation is in flight —
      // makes the rhythm "click click click → wait → tease again"
      // unambiguous instead of stomping mid-shake.
      if (easterPlayingSeq.length > 0) return;
      lookAtCameraUntil = now + LOOK_AT_CAMERA_MS;
      recentClicks = recentClicks.filter(t => now - t < RAPID_CLICK_WINDOW_MS);
      recentClicks.push(now);
      if (recentClicks.length >= RAPID_CLICK_THRESHOLD) {
        recentClicks = [];
        easterPlayingFrom = now;
        easterPlayingSeq = easterLevel === 0 ? EASTER_SHAKE : EASTER_BEHIND;
        easterLevel = (easterLevel + 1) % 2;
        // Easter egg supersedes the look-at-camera override.
        lookAtCameraUntil = 0;
      }
    };
    orbEl.addEventListener("click", onOrbClick);

    const refreshActive = () => {
      pageActive = !document.hidden && document.hasFocus();
    };
    document.addEventListener("visibilitychange", refreshActive);
    window.addEventListener("focus", refreshActive);
    window.addEventListener("blur", refreshActive);

    // Direction from the orb's screen-space center to a target point.
    // Same projection as the old cursor-following code: target right →
    // camera orbits left (negative theta) so the robot's front faces
    // toward it; target below → camera moves above so he looks down.
    const FOCAL_DIST = 350;
    const THETA_LIMIT = 60;
    const PHI_LIMIT = 35;
    const angles = (tx: number, ty: number, cx: number, cy: number) => {
      const dx = tx - cx;
      const dy = ty - cy;
      const theta = Math.max(
        -THETA_LIMIT,
        Math.min(THETA_LIMIT, -(Math.atan2(dx, FOCAL_DIST) * 180) / Math.PI),
      );
      const phi = Math.max(
        -PHI_LIMIT,
        Math.min(PHI_LIMIT, -(Math.atan2(dy, FOCAL_DIST) * 180) / Math.PI),
      );
      return { theta, phi };
    };

    // Animation timings — kept here so it's easy to tune the helper's
    // feel from one place. Slower than typical UI eases on purpose:
    // the head should feel deliberate, not twitchy.
    const DISTRACT_FADE_IN = 380;
    const DISTRACT_HOLD = 1500;
    const DISTRACT_FADE_OUT = 420;
    const EASING = 0.09;

    const tick = () => {
      const now = performance.now();
      // Bob: gentle vertical drift in model space. Translating
      // scene.target carries the entire orb (model + lights +
      // thruster particle systems) up and down together. Auto camera
      // target follows scene.target's bounds, but lights/particles
      // are children of target — and three.js renders the whole
      // hierarchy from the same camera each frame, so the visible
      // result is a pure vertical translate.
      if (!prefersReducedMotion) {
        const bobY = BOB_AMPLITUDE * (1 - Math.cos(now * BOB_OMEGA));
        const scene = (modelEl as unknown as {
          [$scene]?: { target: { position: { y: number } } };
        })[$scene];
        if (scene) scene.target.position.y = bobY;
      }
      const r = orbEl.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      // Bored loop: only fires when the tab/window isn't active —
      // when the player can't see the orb anyway, drift gently rather
      // than holding a stiff pose. With the page focused we always
      // either gaze at the spotlit element or stare forward.
      if (!pageActive) {
        if (now > nextBoredChange) {
          boredTheta = (Math.random() - 0.5) * 60; // ±30°
          boredPhi = (Math.random() - 0.5) * 24; // ±12°
          nextBoredChange = now + 2400 + Math.random() * 2800;
        }
        const boredEasing = 0.045; // half the active easing — slow wander
        currentTheta += (boredTheta - currentTheta) * boredEasing;
        currentPhi += (boredPhi - currentPhi) * boredEasing;
        const orbit = `${(BASE_THETA + currentTheta).toFixed(1)}deg ${(BASE_PHI + currentPhi).toFixed(1)}deg auto`;
        if (modelEl.cameraOrbit !== orbit) {
          modelEl.cameraOrbit = orbit;
        }
        raf = requestAnimationFrame(tick);
        return;
      }
      // Returning to the active path — schedule the next bored beat
      // somewhere in the future so we don't fire one immediately on
      // re-focus.
      nextBoredChange = now + 1000;

      // Resolve element target if we have a selector.
      const selector = lookAtRef.current;
      let elTarget: { theta: number; phi: number } | null = null;
      if (selector) {
        let el: HTMLElement | null = null;
        try {
          el = document.querySelector<HTMLElement>(selector);
        } catch {}
        if (el) {
          const er = el.getBoundingClientRect();
          elTarget = angles(
            er.left + er.width / 2,
            er.top + er.height / 2,
            cx,
            cy,
          );
        }
      }

      // Distractions: when gazing at an element, occasionally pull the
      // goal back toward forward for a brief moment so the stare feels
      // alive instead of laser-locked. Without an element the baseline
      // is already forward, so the state machine still ticks but its
      // mix has nothing to interpolate against.
      if (distractPhase === "idle" && now > nextDistraction) {
        distractPhase = "out";
        phaseStart = now;
      } else if (
        distractPhase === "out" &&
        now - phaseStart > DISTRACT_FADE_IN
      ) {
        distractPhase = "hold";
        phaseStart = now;
      } else if (
        distractPhase === "hold" &&
        now - phaseStart > DISTRACT_HOLD
      ) {
        distractPhase = "back";
        phaseStart = now;
      } else if (
        distractPhase === "back" &&
        now - phaseStart > DISTRACT_FADE_OUT
      ) {
        distractPhase = "idle";
        nextDistraction = now + 25000 + Math.random() * 10000;
      }

      let distractMix = 0;
      if (distractPhase === "out")
        distractMix = (now - phaseStart) / DISTRACT_FADE_IN;
      else if (distractPhase === "hold") distractMix = 1;
      else if (distractPhase === "back")
        distractMix = 1 - (now - phaseStart) / DISTRACT_FADE_OUT;
      distractMix = Math.max(0, Math.min(1, distractMix));

      // Goal: element if available, otherwise forward (the camera-
      // facing pose). When a distraction is active and we're gazing
      // at an element, lerp the goal toward forward by distractMix —
      // briefly looks away, then easing settles back on the element.
      let goalTheta = elTarget?.theta ?? 0;
      let goalPhi = elTarget?.phi ?? 0;
      if (elTarget && distractMix > 0) {
        goalTheta = goalTheta * (1 - distractMix);
        goalPhi = goalPhi * (1 - distractMix);
      }
      // Click-to-engage override wins over both the element gaze and
      // any in-flight distraction.
      if (now < lookAtCameraUntil) {
        goalTheta = 0;
        goalPhi = 0;
      }
      // Easter egg overrides everything else when active. We pick the
      // latest step whose timestamp has elapsed and target its angles
      // — the EMA easing handles the smooth transitions between them.
      if (easterPlayingSeq.length > 0) {
        const elapsed = now - easterPlayingFrom;
        const last = easterPlayingSeq[easterPlayingSeq.length - 1];
        if (elapsed > last.atMs + 600) {
          easterPlayingSeq = [];
        } else {
          let active = easterPlayingSeq[0];
          for (const step of easterPlayingSeq) {
            if (elapsed >= step.atMs) active = step;
            else break;
          }
          goalTheta = active.theta;
          goalPhi = active.phi;
        }
      }

      // Slower lerp for a deliberate head turn — at EASING=0.09 the
      // model takes ~25 frames (~420ms at 60fps) to fully settle on a
      // new static target. This same easing handles the "intro" feel
      // when a new spotlit element appears: the head smoothly slides
      // to it instead of snapping.
      currentTheta += (goalTheta - currentTheta) * EASING;
      currentPhi += (goalPhi - currentPhi) * EASING;

      const orbit = `${(BASE_THETA + currentTheta).toFixed(1)}deg ${(BASE_PHI + currentPhi).toFixed(1)}deg auto`;
      if (modelEl.cameraOrbit !== orbit) {
        modelEl.cameraOrbit = orbit;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      document.removeEventListener("visibilitychange", refreshActive);
      window.removeEventListener("focus", refreshActive);
      window.removeEventListener("blur", refreshActive);
      orbEl.removeEventListener("click", onOrbClick);
      cancelAnimationFrame(raf);
    };
  }, []);

  const isPositioned = placement.positioned;
  const wrapperClass = "tutorial-helper" + (isPositioned ? " positioned" : "");
  const orbStyle = isPositioned
    ? { top: placement.orbTop, left: placement.orbLeft }
    : undefined;
  const bubbleStyle = isPositioned
    ? { top: placement.bubbleTop, left: placement.bubbleLeft }
    : undefined;

  return (
    <div
      className={wrapperClass}
      role="dialog"
      aria-live="polite"
      aria-label="Tutorial helper"
      data-tutorial-look-at={lookAtSelector ?? undefined}
    >
      <div ref={orbRef} className="tutorial-helper-orb" style={orbStyle}>
        <model-viewer
          class="tutorial-helper-orb-model"
          src="/art/3d/robot4_tiny.glb"
          alt="Tutorial helper robot"
          interaction-prompt="none"
          disable-tap
          disable-zoom
          disable-pan
          shadow-intensity="0"
          exposure="1.1"
          tone-mapping="neutral"
          loading="eager"
          reveal="auto"
          camera-orbit="0deg 75deg auto"
        />
      </div>
      <div
        ref={bubbleRef}
        className="tutorial-helper-bubble"
        style={bubbleStyle}
      >
        <div className="tutorial-helper-bubble-tail" aria-hidden="true" />
        {audioControls && (
          <div className="tutorial-helper-audio-controls" aria-label="Tutorial audio controls">
            <button
              type="button"
              className={`tutorial-helper-audio-button ${audioControls.needsActivation ? "needs-activation" : ""}`}
              onClick={audioControls.replay}
              title={audioControls.needsActivation ? "Click to start audio" : "Replay"}
              aria-label={audioControls.needsActivation ? "Start tutorial audio" : "Replay tutorial audio"}
            >
              <MdReplay aria-hidden="true" focusable="false" />
            </button>
            <div className="tutorial-helper-audio-volume">
              <button
                type="button"
                className={`tutorial-helper-audio-button ${audioControls.muted ? "muted" : ""}`}
                onClick={audioControls.toggleMute}
                title={audioControls.muted ? "Unmute" : "Mute"}
                aria-label={audioControls.muted ? "Unmute tutorial audio" : "Mute tutorial audio"}
                aria-pressed={audioControls.muted}
              >
                {audioControls.muted ? (
                  <MdVolumeOff aria-hidden="true" focusable="false" />
                ) : (
                  <MdVolumeUp aria-hidden="true" focusable="false" />
                )}
              </button>
              {/* Slider popover — hidden by default, revealed on hover
                  / focus of the wrapper. Keeps the mute toggle clean
                  while letting the player dial volume in when needed. */}
              <div
                className="tutorial-helper-audio-volume-popover"
                role="presentation"
              >
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={Math.round(audioControls.volume * 100)}
                  onChange={e => audioControls.setVolume(Number(e.target.value) / 100)}
                  aria-label="Tutorial audio volume"
                  className="tutorial-helper-audio-volume-slider"
                />
              </div>
            </div>
          </div>
        )}
        <h3 className="tutorial-helper-title">{title}</h3>
        <div className="tutorial-helper-body">{body}</div>
        <div className="tutorial-helper-actions">
          {onAdvance && (
            <button
              type="button"
              className="tutorial-helper-button advance"
              onClick={onAdvance}
            >
              {advanceLabel}
            </button>
          )}
          {onSkip && (
            <button
              type="button"
              className={`tutorial-helper-button ${neutralSkip ? "" : "skip"}`}
              onClick={onSkip}
            >
              {skipLabel}
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              className="tutorial-helper-button dismiss"
              onClick={onDismiss}
            >
              {dismissLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
