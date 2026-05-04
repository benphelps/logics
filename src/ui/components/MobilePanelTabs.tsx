import "./MobilePanelTabs.css";

export interface MobilePanelDef<TId extends string> {
  id: TId;
  label: string;
  count?: number;
}

interface MobilePanelTabsProps<TId extends string> {
  panels: readonly MobilePanelDef<TId>[];
  active: TId;
  onChange: (id: TId) => void;
  className?: string;
}

// Sub-tab strip rendered below the main view-tabs on mobile. Uses the
// exact .topbar-tabs / .topbar-tab styling so it visually reads as a
// second row of the same tab system.
export function MobilePanelTabs<TId extends string>({ panels, active, onChange, className = "" }: MobilePanelTabsProps<TId>) {
  return (
    <nav className={`topbar-tabs mobile-panel-tabs ${className}`} role="tablist" aria-label="Panel selector">
      {panels.map((panel) => (
        <button
          key={panel.id}
          type="button"
          role="tab"
          aria-selected={active === panel.id}
          className={`topbar-tab ${active === panel.id ? "active" : ""}`}
          onClick={() => onChange(panel.id)}
        >
          {panel.label}
        </button>
      ))}
    </nav>
  );
}
