import { useStore } from "./store";
import { useTickDriver } from "./useTickDriver";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";
import { MarketsView } from "./views/MarketsView";
import { LocationsView } from "./views/LocationsView";
import { PlayerView } from "./views/PlayerView";
import "./App.css";

export function App() {
  useTickDriver();
  const tab = useStore((s) => s.selectedTab);

  return (
    <div className="app">
      <TopBar />
      <div className="app-body">
        <Sidebar />
        <main className="app-main">
          {tab === "markets"   && <MarketsView />}
          {tab === "locations" && <LocationsView />}
          {tab === "player"    && <PlayerView />}
        </main>
      </div>
    </div>
  );
}
