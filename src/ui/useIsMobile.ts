import { useEffect, useState } from "react";

export const MOBILE_BREAKPOINT_PX = 900;

// Test override: visiting `?mobile=1` forces mobile layout on, `?mobile=0`
// forces it off. Lets us validate the deploy + layout independently of
// the device's reported viewport.
function readForceMobile(): boolean | null {
  if (typeof window === "undefined") return null;
  try {
    const value = new URLSearchParams(window.location.search).get("mobile");
    if (value === "1" || value === "true") return true;
    if (value === "0" || value === "false") return false;
  } catch {
    /* noop */
  }
  return null;
}

// Returns true when the viewport matches the mobile media query. Uses
// matchMedia rather than window.innerWidth because innerWidth on iOS
// Safari can include the address bar / safe areas inconsistently;
// matchMedia honors the same rules as CSS @media queries so the JS
// state stays in sync with stylesheet breakpoints.
export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT_PX): boolean {
  const query = `(max-width: ${breakpoint - 1}px)`;
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    const forced = readForceMobile();
    if (forced != null) return forced;
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });
  useEffect(() => {
    const forced = readForceMobile();
    if (forced != null) {
      setIsMobile(forced);
      return;
    }
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
