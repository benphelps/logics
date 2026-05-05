import { useCallback, useEffect, useMemo, useState } from "react";
import { createTrackerSnapshot, KeygenTracker, type TrackerModeId, type TrackerSnapshot } from "./keygenTracker";

export interface KeygenMusicControls {
  snapshot: TrackerSnapshot;
  start: () => void;
  stop: () => void;
  toggle: () => void;
  regenerate: () => void;
  setVolume: (volume: number) => void;
  setMode: (mode: TrackerModeId) => void;
}

export function useKeygenMusic(): KeygenMusicControls {
  const [snapshot, setSnapshot] = useState<TrackerSnapshot>(() => createTrackerSnapshot());
  const engine = useMemo(
    () => typeof window !== "undefined" ? new KeygenTracker(setSnapshot) : null,
    [],
  );

  useEffect(() => {
    return () => engine?.dispose();
  }, [engine]);

  const start = useCallback(() => {
    void engine?.start();
  }, [engine]);

  const stop = useCallback(() => {
    engine?.stop();
  }, [engine]);

  const toggle = useCallback(() => {
    if (!engine) return;
    if (engine.snapshot().playing) engine.stop();
    else void engine.start();
  }, [engine]);

  const regenerate = useCallback(() => {
    engine?.regenerate();
  }, [engine]);

  const setVolume = useCallback((volume: number) => {
    engine?.setVolume(volume);
  }, [engine]);

  const setMode = useCallback((mode: TrackerModeId) => {
    engine?.setMode(mode);
  }, [engine]);

  return { snapshot, start, stop, toggle, regenerate, setVolume, setMode };
}
