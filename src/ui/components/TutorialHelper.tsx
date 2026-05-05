import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import "@google/model-viewer";
import "./TutorialHelper.css";

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
  // orb is the only thing on screen. "bottom-right" pins to a corner —
  // useful when something else (e.g. the new-game modal) already owns
  // the centre and the orb shouldn't cover it.
  fallbackPlacement?: "center" | "bottom-right";
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
// Negative: the bubble overlaps the orb. The model is auto-framed to
// the upper-middle of its container, leaving empty space at the bottom
// — this overlap pulls the bubble up so its top edge sits just under
// the model's thrusters / silhouette base.
const BUBBLE_GAP = -70;
// Shifts the orb vertically relative to its target's center. Negative
// nudges him upward — useful when the current model's visual mass sits
// low in its bounding box, so simple centering puts his body too low.
const ORB_Y_OFFSET = -20;
const EDGE_MARGIN = 16; // viewport edge buffer

const ORB_FALLBACK_W = 240;
const ORB_FALLBACK_H = 244;
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
}: TutorialHelperProps) {
  const orbRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  // Stable ref so the rAF loop (mounted once) can read the latest
  // selector without re-subscribing on every prop change.
  const lookAtRef = useRef<string | null | undefined>(lookAtSelector);
  lookAtRef.current = lookAtSelector;
  // Timestamp marking the start of an "intro gaze" — the rAF loop holds
  // the gaze on the spotlit element for ~1.6s after every step change
  // before returning to cursor tracking. Feels like he's settling in
  // and pointing out what to look at.
  const introGazeAtRef = useRef<number>(performance.now());
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

        if (fallbackPlacement === "bottom-right") {
          // Pinned to bottom-right corner with the bubble extending
          // upward (orb-on-bottom, bubble-on-top). The whole stack stays
          // out of the centred modal's footprint.
          const margin = 28;
          orbLeft = vw - orbW - margin;
          orbTop = vh - orbH - margin;
          bubbleLeft = vw - bubbleW - margin;
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

  // Mark the start of an intro gaze each time the step swaps. The rAF
  // loop reads introGazeAtRef and lerps toward the spotlit element for
  // ~1.6s before easing back to cursor tracking.
  useEffect(() => {
    introGazeAtRef.current = performance.now();
  }, [title, lookAtSelector]);

  // Cursor tracking + occasional distraction glance at the spotlit
  // element. Runs once on mount; reads the latest selector via ref so
  // we never restart the rAF loop. We orbit the *camera* around the
  // model rather than rotating the model itself, because the model's
  // `orientation` setter triggers ARRenderer.onUpdateScene which is
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

    let cursorX = window.innerWidth / 2;
    let cursorY = window.innerHeight / 2;
    // Tracks whether the page is visible AND the window has focus.
    // When false, we ignore the stale cursor (which is parked wherever
    // the user dragged it off-screen) and run a bored-loop wander pose
    // instead so he doesn't keep staring at a screen edge.
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
    // Each trigger picks a goal — either the spotlit element (showing
    // the player something) or "idle" (just stares forward, like he's
    // zoning out for a moment).
    let distractPhase: "idle" | "out" | "hold" | "back" = "idle";
    let distractGoal: "element" | "idle" = "idle";
    let phaseStart = 0;
    let nextDistraction = performance.now() + 25000 + Math.random() * 10000;
    let raf = 0;

    const onMove = (e: MouseEvent) => {
      cursorX = e.clientX;
      cursorY = e.clientY;
    };
    document.addEventListener("mousemove", onMove);

    const refreshActive = () => {
      pageActive = !document.hidden && document.hasFocus();
    };
    document.addEventListener("visibilitychange", refreshActive);
    window.addEventListener("focus", refreshActive);
    window.addEventListener("blur", refreshActive);

    // Direct point-at-cursor: angle from orb to target on a plane
    // FOCAL_DIST in front. Cursor right → camera orbits left (negative
    // theta) so the robot's front faces right. Cursor below → camera
    // moves above (phi smaller) so the robot appears to look down.
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

    // Animation timings — kept here so it's easy to tune the whole
    // helper's feel from one place. Slower than typical UI eases on
    // purpose: the head should feel deliberate, not twitchy.
    const INTRO_FADE_IN = 280;
    const INTRO_HOLD = 2000;
    const INTRO_FADE_OUT = 650;
    const DISTRACT_FADE_IN = 380;
    const DISTRACT_HOLD = 1500;
    const DISTRACT_FADE_OUT = 420;
    const EASING = 0.09;

    const tick = () => {
      const now = performance.now();
      const r = orbEl.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;

      // Bored loop: triggered when either the tab/window isn't active,
      // or there's no spotlit element (intro/transition/farewell stops
      // where the helper is centered on screen). In both cases the
      // cursor is irrelevant — pick a fresh random target every few
      // seconds and slowly drift toward it.
      const idle = !pageActive || !lookAtRef.current;
      if (idle) {
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

      const cursorTarget = angles(cursorX, cursorY, cx, cy);

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

      // Intro gaze: only meaningful when there's an element to point at.
      const introElapsed = now - introGazeAtRef.current;
      const introWindow = INTRO_FADE_IN + INTRO_HOLD + INTRO_FADE_OUT;
      let introMix = 0;
      if (elTarget && introElapsed >= 0 && introElapsed < introWindow) {
        if (introElapsed < INTRO_FADE_IN) introMix = introElapsed / INTRO_FADE_IN;
        else if (introElapsed < INTRO_FADE_IN + INTRO_HOLD) introMix = 1;
        else
          introMix = 1 - (introElapsed - INTRO_FADE_IN - INTRO_HOLD) / INTRO_FADE_OUT;
      }
      const introActive = introMix > 0.001;

      // Distractions never fire during an intro — let it land cleanly.
      // After that, periodically pick between glancing at the element
      // (if available) or just staring forward (idle pose). Without an
      // element, every distraction is the idle-forward pose.
      if (!introActive) {
        if (distractPhase === "idle" && now > nextDistraction) {
          distractPhase = "out";
          phaseStart = now;
          distractGoal =
            elTarget && Math.random() < 0.55 ? "element" : "idle";
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
      } else if (distractPhase !== "idle") {
        // An intro started mid-distraction — drop it cleanly.
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

      // Pick which goal pose we're easing toward. Intro always wins;
      // outside that, distract goal decides; otherwise we just track
      // the cursor.
      let goalTheta = cursorTarget.theta;
      let goalPhi = cursorTarget.phi;
      let mix = 0;
      if (introMix > 0 && elTarget) {
        goalTheta = elTarget.theta;
        goalPhi = elTarget.phi;
        mix = introMix;
      } else if (distractMix > 0) {
        if (distractGoal === "element" && elTarget) {
          goalTheta = elTarget.theta;
          goalPhi = elTarget.phi;
        } else {
          // Idle pose — face forward, no offsets from the base orbit.
          goalTheta = 0;
          goalPhi = 0;
        }
        mix = distractMix;
      }
      const target = {
        theta: cursorTarget.theta * (1 - mix) + goalTheta * mix,
        phi: cursorTarget.phi * (1 - mix) + goalPhi * mix,
      };

      // Slower lerp for a deliberate head turn — at EASING=0.09 the
      // model takes ~25 frames (~420ms at 60fps) to fully settle on a
      // new static target.
      currentTheta += (target.theta - currentTheta) * EASING;
      currentPhi += (target.phi - currentPhi) * EASING;

      const orbit = `${(BASE_THETA + currentTheta).toFixed(1)}deg ${(BASE_PHI + currentPhi).toFixed(1)}deg auto`;
      if (modelEl.cameraOrbit !== orbit) {
        modelEl.cameraOrbit = orbit;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);

    return () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("visibilitychange", refreshActive);
      window.removeEventListener("focus", refreshActive);
      window.removeEventListener("blur", refreshActive);
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
