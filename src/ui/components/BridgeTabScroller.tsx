import { useEffect } from "react";

const TAB_BAR_SELECTOR = ".bridge-card-tabs";
const EDGE_EPSILON = 1;
const SCROLL_EASING = 0.22;
const MAX_EDGE_ZONE_RATIO = 0.45;
const PROXIMITY_RANGE_X_PX = 56;
const PROXIMITY_RANGE_Y_PX = 96;
const PROXIMITY_SOFT_ZONE = 40 / 56;
const PROXIMITY_RAMP_ZONE = 50 / 56;
const MIN_PROXIMITY_INFLUENCE = 0.02;

function updateTabBarEdges(el: HTMLElement) {
  const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
  const overflowing = maxScroll > EDGE_EPSILON;
  const startEdge = overflowing && el.scrollLeft > EDGE_EPSILON;
  const endEdge = overflowing && el.scrollLeft < maxScroll - EDGE_EPSILON;
  const suggestionEdges = overflowing ? hiddenSuggestionEdges(el, startEdge, endEdge) : { start: false, end: false };
  el.classList.toggle("bridge-tabs-overflowing", overflowing);
  el.classList.toggle("bridge-tabs-edge-start", startEdge);
  el.classList.toggle("bridge-tabs-edge-end", endEdge);
  el.classList.toggle("bridge-tabs-suggestion-start", suggestionEdges.start);
  el.classList.toggle("bridge-tabs-suggestion-end", suggestionEdges.end);
  if (!overflowing && el.scrollLeft !== 0) el.scrollLeft = 0;
}

function hiddenSuggestionEdges(el: HTMLElement, startEdge: boolean, endEdge: boolean): { start: boolean; end: boolean } {
  const fadeWidth = parseFloat(getComputedStyle(el).getPropertyValue("--bridge-tab-edge-fade-width")) || 0;
  const visibleStart = el.scrollLeft + fadeWidth;
  const visibleEnd = el.scrollLeft + el.clientWidth - fadeWidth;
  let start = false;
  let end = false;

  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (!child.matches(".has-suggestion") && !child.querySelector(".has-suggestion")) continue;
    const childStart = child.offsetLeft;
    const childEnd = childStart + child.offsetWidth;
    start ||= startEdge && childStart < visibleStart;
    end ||= endEdge && childEnd > visibleEnd;
    if (start && end) break;
  }

  return { start, end };
}

function pointerScrollRatio(el: HTMLElement, clientX: number): number {
  const rect = el.getBoundingClientRect();
  const width = Math.max(1, rect.width);
  const x = Math.max(0, Math.min(width, clientX - rect.left));
  const children = Array.from(el.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
  const firstWidth = children[0]?.getBoundingClientRect().width ?? width * 0.3;
  const lastWidth = children[children.length - 1]?.getBoundingClientRect().width ?? width * 0.3;
  const leftZone = Math.min(firstWidth, width * MAX_EDGE_ZONE_RATIO);
  const rightZone = Math.min(lastWidth, width * MAX_EDGE_ZONE_RATIO);
  const middleWidth = Math.max(1, width - leftZone - rightZone);
  return Math.max(0, Math.min(1, (x - leftZone) / middleWidth));
}

function proximityToRect(rect: DOMRect, x: number, y: number): number {
  const dx = x < rect.left ? rect.left - x : x > rect.right ? x - rect.right : 0;
  const dy = y < rect.top ? rect.top - y : y > rect.bottom ? y - rect.bottom : 0;
  const distance = Math.hypot(dx / PROXIMITY_RANGE_X_PX, dy / PROXIMITY_RANGE_Y_PX);
  if (distance > 1) return 0;
  const proximity = 1 - distance;
  if (proximity >= PROXIMITY_RAMP_ZONE) return 1;
  if (proximity >= PROXIMITY_SOFT_ZONE) {
    const t = (proximity - PROXIMITY_SOFT_ZONE) / (PROXIMITY_RAMP_ZONE - PROXIMITY_SOFT_ZONE);
    return 0.14 + 0.54 * (1 - Math.pow(1 - t, 3));
  }
  const t = proximity / PROXIMITY_SOFT_ZONE;
  return MIN_PROXIMITY_INFLUENCE + 0.12 * t * t;
}

export function BridgeTabScroller() {
  useEffect(() => {
    const observed = new Set<HTMLElement>();
    let lastEl: HTMLElement | null = null;
    let lastInfluence = 0;
    let mutationFrame = 0;

    const syncTabBars = () => {
      document.querySelectorAll<HTMLElement>(TAB_BAR_SELECTOR).forEach(el => {
        if (!observed.has(el)) {
          observed.add(el);
          el.addEventListener("scroll", onScroll, { passive: true });
          resizeObserver.observe(el);
        }
        updateTabBarEdges(el);
      });

      for (const el of [...observed]) {
        if (document.body.contains(el)) continue;
        observed.delete(el);
        el.removeEventListener("scroll", onScroll);
        resizeObserver.unobserve(el);
        if (lastEl === el) {
          lastEl = null;
          lastInfluence = 0;
        }
      }
    };

    const queueSyncTabBars = () => {
      if (mutationFrame !== 0) return;
      mutationFrame = requestAnimationFrame(() => {
        mutationFrame = 0;
        syncTabBars();
      });
    };

    const onPointerMove = (event: PointerEvent) => {
      let best: { el: HTMLElement; influence: number; maxScroll: number } | null = null;
      for (const el of observed) {
        const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
        updateTabBarEdges(el);
        if (maxScroll <= EDGE_EPSILON) continue;
        const influence = proximityToRect(el.getBoundingClientRect(), event.clientX, event.clientY);
        if (influence <= 0) continue;
        if (!best || influence > best.influence) best = { el, influence, maxScroll };
      }

      if (!best) {
        lastEl = null;
        lastInfluence = 0;
        return;
      }

      const movingCloser = best.el !== lastEl || best.influence >= lastInfluence - 0.001;
      lastEl = best.el;
      lastInfluence = best.influence;
      if (!movingCloser) return;

      const targetScroll = best.maxScroll * pointerScrollRatio(best.el, event.clientX);
      const delta = targetScroll - best.el.scrollLeft;
      if (Math.abs(delta) >= 0.5) {
        best.el.scrollLeft += delta * SCROLL_EASING * best.influence;
      }
      updateTabBarEdges(best.el);
    };

    function onScroll(event: Event) {
      if (event.currentTarget instanceof HTMLElement) updateTabBarEdges(event.currentTarget);
    }

    const resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) updateTabBarEdges(entry.target as HTMLElement);
    });
    const mutationObserver = new MutationObserver(queueSyncTabBars);

    syncTabBars();
    window.addEventListener("resize", syncTabBars);
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    mutationObserver.observe(document.body, { attributes: true, attributeFilter: ["class"], childList: true, subtree: true });

    return () => {
      if (mutationFrame !== 0) cancelAnimationFrame(mutationFrame);
      window.removeEventListener("resize", syncTabBars);
      document.removeEventListener("pointermove", onPointerMove);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      for (const el of observed) el.removeEventListener("scroll", onScroll);
      observed.clear();
    };
  }, []);

  return null;
}
