import { useEffect, useState } from "react";

const DEFAULT_BREAKPOINT_PX = 900;

// Returns true when viewport width is below `breakpoint`. Drives the
// per-view "panels become sub-tabs" mobile layout. Listens to resize so
// rotating a tablet between portrait/landscape flips the layout live.
export function useIsMobile(breakpoint: number = DEFAULT_BREAKPOINT_PX): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.innerWidth < breakpoint;
  });
  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < breakpoint);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [breakpoint]);
  return isMobile;
}
