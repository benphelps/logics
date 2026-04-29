import { useEffect } from "react";
import { useStore } from "./store";

export function useTickDriver(): void {
  const speed = useStore((s) => s.speed);
  const step = useStore((s) => s.step);
  // Any player ship mid-unload forces ticks at ≥1x even if the user paused —
  // so a Sell click while paused still plays out its progress bar without the
  // player having to manually unpause and re-pause.
  const playerUnloading = useStore((s) => {
    const ids = s.world.player?.shipIds ?? [];
    return ids.some(id => {
      const t = s.world.traders[id];
      return t != null && (t.unloadingCargo?.length ?? 0) > 0;
    });
  });

  useEffect(() => {
    const effective = Math.max(speed, playerUnloading ? 1 : 0);
    if (effective === 0) return;
    const intervalMs = 1000 / effective;
    const id = setInterval(step, intervalMs);
    return () => clearInterval(id);
  }, [speed, playerUnloading, step]);
}
