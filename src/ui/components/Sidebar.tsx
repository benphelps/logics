import { useStore, type Tab } from "../store";
import "./Sidebar.css";

const TABS: { id: Tab; label: string; hint?: string }[] = [
  { id: "player",    label: "My Fleet" },
  { id: "markets",   label: "Markets" },
  { id: "locations", label: "Atlas" },
  { id: "stocks",    label: "Exchange" },
];

export function Sidebar() {
  const selected = useStore((s) => s.selectedTab);
  const select = useStore((s) => s.selectTab);

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`sidebar-tab ${selected === t.id ? "active" : ""}`}
            onClick={() => select(t.id)}
          >
            <span>{t.label}</span>
            {t.hint && <span className="sidebar-tab-hint faint">{t.hint}</span>}
          </button>
        ))}
      </nav>
    </aside>
  );
}
