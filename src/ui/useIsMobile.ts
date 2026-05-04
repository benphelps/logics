import { useEffect, useState } from "react";

export const MOBILE_BREAKPOINT_PX = 900;

// Returns true when the viewport matches the mobile media query. Uses
// matchMedia rather than window.innerWidth because innerWidth on iOS
// Safari can include the address bar / safe areas inconsistently;
// matchMedia honors the same rules as CSS @media queries so the JS
// state stays in sync with stylesheet breakpoints.
export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT_PX): boolean {
  const query = `(max-width: ${breakpoint - 1}px)`;
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    const onChange = (ev: MediaQueryListEvent) => setIsMobile(ev.matches);
    setIsMobile(mql.matches);
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onChange);
      return () => mql.removeEventListener("change", onChange);
    }
    // Older Safari fallback
    const legacy = mql as unknown as { addListener(cb: (ev: MediaQueryListEvent) => void): void; removeListener(cb: (ev: MediaQueryListEvent) => void): void };
    legacy.addListener(onChange);
    return () => legacy.removeListener(onChange);
  }, [query]);
  return isMobile;
}
