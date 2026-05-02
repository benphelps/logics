import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { useStore, type Tab } from "./store";
import { useTickDriver } from "./useTickDriver";
import { TopBar } from "./components/TopBar";
import { BridgeTabScroller } from "./components/BridgeTabScroller";
import { NewGameModal } from "./components/NewGameModal";
import { ChartersView } from "./views/ChartersView";
import { MarketsView } from "./views/MarketsView";
import { LocationsView } from "./views/LocationsView";
import { PlayerView } from "./views/PlayerView";
import { StockMarketView } from "./views/StockMarketView";
import { NewsToast } from "./views/NewsToast";
import { loadNewsPool } from "../sim/news/pool";
import "./App.css";

export function App() {
  useTickDriver();
  useHeaderArtCursorPan();
  useEffect(() => { void loadNewsPool(); }, []);
  const tab = useStore((s) => s.selectedTab);
  const saveCurrentGame = useStore((s) => s.saveCurrentGame);
  usePanelScrollMemory(tab);

  useEffect(() => {
    const flushSave = () => saveCurrentGame();
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") flushSave();
    };
    window.addEventListener("beforeunload", flushSave);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.removeEventListener("beforeunload", flushSave);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [saveCurrentGame]);

  return (
    <div className="app">
      <div className="app-body">
        <main className="app-main">
          <TopBar />
          <div className="app-view">
            {tab === "markets"   && <MarketsView />}
            {tab === "locations" && <LocationsView />}
            {tab === "player"    && <PlayerView />}
            {tab === "stocks"    && <StockMarketView />}
            {tab === "charters"  && <ChartersView />}
          </div>
        </main>
      </div>
      <NewsToast />
      <NewGameModal />
      <BridgeTabScroller />
    </div>
  );
}

const PANEL_SCROLL_SELECTOR = "[data-scroll-key]";

function usePanelScrollMemory(tab: Tab) {
  const setPanelScrollPosition = useStore((s) => s.setPanelScrollPosition);
  const activeSaveId = useStore((s) => s.activeSaveId);
  const restoreFrameRef = useRef<number | null>(null);

  const restorePanelScrollPositions = useCallback(() => {
    if (restoreFrameRef.current != null) window.cancelAnimationFrame(restoreFrameRef.current);
    restoreFrameRef.current = window.requestAnimationFrame(() => {
      restoreFrameRef.current = null;
      const positions = useStore.getState().panelScrollPositions;
      const panels = document.querySelectorAll<HTMLElement>(PANEL_SCROLL_SELECTOR);
      for (const panel of panels) {
        const key = panel.dataset.scrollKey;
        const position = key ? positions[key] : undefined;
        if (!position) continue;
        const top = Math.min(position.top, Math.max(0, panel.scrollHeight - panel.clientHeight));
        const left = Math.min(position.left, Math.max(0, panel.scrollWidth - panel.clientWidth));
        if (panel.scrollTop !== top) panel.scrollTop = top;
        if (panel.scrollLeft !== left) panel.scrollLeft = left;
      }
    });
  }, []);

  useLayoutEffect(() => {
    restorePanelScrollPositions();
    return () => {
      if (restoreFrameRef.current != null) {
        window.cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
    };
  }, [activeSaveId, tab, restorePanelScrollPositions]);

  useEffect(() => {
    const handleScroll = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const key = target.dataset.scrollKey;
      if (!key) return;
      setPanelScrollPosition(key, { top: target.scrollTop, left: target.scrollLeft });
    };

    document.addEventListener("scroll", handleScroll, true);
    const root = document.querySelector(".app") ?? document.body;
    const observer = new MutationObserver(restorePanelScrollPositions);
    observer.observe(root, {
      attributes: true,
      attributeFilter: ["data-scroll-key"],
      childList: true,
      subtree: true,
    });
    restorePanelScrollPositions();

    return () => {
      document.removeEventListener("scroll", handleScroll, true);
      observer.disconnect();
      if (restoreFrameRef.current != null) {
        window.cancelAnimationFrame(restoreFrameRef.current);
        restoreFrameRef.current = null;
      }
    };
  }, [restorePanelScrollPositions, setPanelScrollPosition]);
}

function useHeaderArtCursorPan() {
  useEffect(() => {
    const root = document.documentElement;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const panXMin = 35;
    const panXRange = 30;
    const panYMin = 43.75;
    const panYRange = 12.5;
    let currentX = 50;
    let currentY = 50;
    let targetX = 50;
    let targetY = 50;
    let raf = 0;

    const setVars = (x: number, y: number) => {
      root.style.setProperty("--header-art-pan-x", `${x.toFixed(2)}%`);
      root.style.setProperty("--header-art-pan-y", `${y.toFixed(2)}%`);
    };

    const tick = () => {
      currentX += (targetX - currentX) * 0.015;
      currentY += (targetY - currentY) * 0.015;
      setVars(currentX, currentY);
      raf = requestAnimationFrame(tick);
    };

    const handlePointerMove = (event: PointerEvent) => {
      if (reduceMotion.matches) return;
      const width = Math.max(1, window.innerWidth);
      const height = Math.max(1, window.innerHeight);
      targetX = panXMin + (event.clientX / width) * panXRange;
      targetY = panYMin + (event.clientY / height) * panYRange;
    };

    setVars(currentX, currentY);
    if (!reduceMotion.matches) {
      raf = requestAnimationFrame(tick);
      window.addEventListener("pointermove", handlePointerMove, { passive: true });
    }

    return () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", handlePointerMove);
      root.style.removeProperty("--header-art-pan-x");
      root.style.removeProperty("--header-art-pan-y");
    };
  }, []);
}
