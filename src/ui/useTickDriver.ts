import { useEffect } from "react";
import { useStore } from "./store";

export function useTickDriver(): void {
  const speed = useStore((s) => s.speed);
  const step = useStore((s) => s.step);

  useEffect(() => {
    if (speed === 0) return;
    const intervalMs = 1000 / speed;
    const id = setInterval(step, intervalMs);
    return () => clearInterval(id);
  }, [speed, step]);
}
