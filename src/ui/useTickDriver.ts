import { useEffect } from "react";
import { useStore } from "./store";

export function useTickDriver(): void {
  const speed = useStore((s) => s.speed);
  const step = useStore((s) => s.step);
  // A MANUAL-pilot player ship mid-unload forces ticks at ≥1x even if the
  // user paused — so a Sell click while paused still plays out its progress
  // bar without the player having to unpause and re-pause. Auto-pilot ships
  // don't get this override: they continuously start their own trades, and
  // letting them bypass pause turns "click Step once" into a runaway tick
  // loop. Auto ships' unload progress continues normally at speed ≥1x.
  const playerUnloading = useStore((s) => {
    const ids = s.world.player?.shipIds ?? [];
    return ids.some(id => {
      const t = s.world.traders[id];
      if (t == null || t.pilot === "auto") return false;
      return (t.unloadingCargo?.length ?? 0) > 0;
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
