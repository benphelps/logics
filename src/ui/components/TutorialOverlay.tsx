import { useLayoutEffect, useState } from "react";
import "./TutorialOverlay.css";

// Renders a fullscreen dim with a transparent rectangle cut out around
// the first element matching the given CSS selector. The cutout uses
// inset box-shadow on a positioned div sized to the target's bounding
// rect, so the overlay's pointer-events stay none and the spotlit
// element remains fully clickable.
//
// `selector` is a raw CSS selector — pass `[data-tutorial="cargo-list"]`,
// `[data-tutorial-buy-good="parts"]`, or any composite query. Granular
// row-level targeting lets the tutorial point at the exact button the
// player needs to click instead of dimming the whole tab.
//
// `padding` adds breathing room so the highlight doesn't kiss the
// element's edge. `interactive` controls whether the dim swallows clicks
// outside the cutout — true for the interface tour (clicks land on the
// helper's Next/Skip), false during action tutorials (player still needs
// to click around the UI to find the highlighted control).
export interface TutorialOverlayProps {
  selector: string | null;
  interactive?: boolean;
  padding?: number;
  // Border-radius for the cutout. Most highlight targets are buttons or
  // panels with rounded corners — match them so the spotlight tracks the
  // element's silhouette instead of leaving slivers of dim at the corners.
  radius?: number;
  // Render a full-screen dim with NO cutout. Used by intro / transition
  // tour stops where the orb is monologuing and there's nothing to point
  // at. Honoured even when selector is null.
  fullDim?: boolean;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const DEFAULT_PADDING = 6;
const DEFAULT_RADIUS = 12;

export function TutorialOverlay({
  selector,
  interactive = false,
  padding = DEFAULT_PADDING,
  radius = DEFAULT_RADIUS,
  fullDim = false,
}: TutorialOverlayProps) {
  const [rect, setRect] = useState<Rect | null>(null);

  useLayoutEffect(() => {
    // useLayoutEffect runs after DOM mutations but before paint, so the
    // first measure lands on a fully-laid-out tree. We call setRect
    // synchronously inside; the lint rule about "no setState in effects"
    // is targeted at useEffect's render-cascade pattern, which doesn't
    // apply to layout effects whose whole purpose is measuring DOM.
    let lastSelector: string | null = null;
    const measure = () => {
      if (!selector) {
        setRect(null);
        return;
      }
      let el: HTMLElement | null;
      try {
        el = document.querySelector<HTMLElement>(selector);
      } catch {
        // Malformed CSS selector — never crash the overlay over a typo.
        el = null;
      }
      if (!el) {
        setRect(null);
        return;
      }
      // First time we see a target for this selector, scroll it into
      // view inside its scroll container. Long lists (markets, travel,
      // contracts) scroll independently; without this the spotlight
      // would land on a row clipped above the fold and the player
      // wouldn't see what to click.
      if (lastSelector !== selector) {
        lastSelector = selector;
        try {
          el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
        } catch {
          // Older browsers may reject the options bag — call without.
          el.scrollIntoView();
        }
      }
      const r = el.getBoundingClientRect();
      const next: Rect = {
        top: r.top - padding,
        left: r.left - padding,
        width: r.width + padding * 2,
        height: r.height + padding * 2,
      };
      setRect(prev => {
        if (prev && prev.top === next.top && prev.left === next.left
            && prev.width === next.width && prev.height === next.height) {
          return prev;
        }
        return next;
      });
    };

    measure();
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);

    const root = document.querySelector(".app") ?? document.body;
    const observer = new MutationObserver(measure);
    observer.observe(root, { subtree: true, childList: true, attributes: true });

    // Cheap polling for animated panels (modal slide-ins, sub-tab swaps
    // that delay-mount) where MutationObserver may miss the final layout.
    const interval = window.setInterval(measure, 250);

    return () => {
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
      observer.disconnect();
      window.clearInterval(interval);
    };
  }, [selector, padding]);

  // Full-dim mode: render a flat dim with no cutout. Used for intro /
  // transition orb beats where there's nothing to spotlight; the
  // helper bubble carries the message.
  if (!selector && fullDim) {
    return (
      <div
        className={`tutorial-overlay tutorial-overlay-full ${interactive ? "interactive" : ""}`}
        aria-hidden="true"
      />
    );
  }
  if (!selector) return null;

  // No target element found — render nothing. A full-screen dim here
  // would feel like "the tutorial is broken"; the orb body still tells
  // the player what to do, and the spotlight reappears the moment the
  // target mounts (e.g. they switch to the right sub-tab).
  if (!rect) return null;

  // Center of the cutout drives the radial dim — the dim sits lightest
  // around the spotlit element and deepens toward the corners of the
  // viewport so the player's eye is drawn inward.
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  const innerR = Math.max(rect.width, rect.height) / 2 + padding;
  const overlayStyle = {
    "--tutorial-cutout-x": `${cx}px`,
    "--tutorial-cutout-y": `${cy}px`,
    "--tutorial-cutout-r": `${innerR}px`,
  } as React.CSSProperties;
  return (
    <div
      className={`tutorial-overlay ${interactive ? "interactive" : ""}`}
      aria-hidden="true"
      style={overlayStyle}
    >
      <div
        className="tutorial-overlay-cutout"
        style={{
          top: rect.top,
          left: rect.left,
          width: rect.width,
          height: rect.height,
          borderRadius: radius,
        }}
      />
    </div>
  );
}
