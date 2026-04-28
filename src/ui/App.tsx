import { useEffect } from "react";
import { useStore } from "./store";
import { useTickDriver } from "./useTickDriver";
import { TopBar } from "./components/TopBar";
import { MarketsView } from "./views/MarketsView";
import { LocationsView } from "./views/LocationsView";
import { PlayerView } from "./views/PlayerView";
import { StockMarketView } from "./views/StockMarketView";
import "./App.css";

export function App() {
  useTickDriver();
  const tab = useStore((s) => s.selectedTab);
  const saveCurrentGame = useStore((s) => s.saveCurrentGame);

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
          </div>
        </main>
      </div>
    </div>
  );
}
