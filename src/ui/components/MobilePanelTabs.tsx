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

// Sub-tab strip that sits below the top-bar view tabs on mobile. One
// tab per panel; the active panel is rendered solo while the rest are
// hidden via CSS in the host view.
export function MobilePanelTabs<TId extends string>({ panels, active, onChange, className = "" }: MobilePanelTabsProps<TId>) {
  return (
    <div className={`bridge-card-tabs mobile-panel-tabs ${className}`} role="tablist" aria-label="Panel selector">
      {panels.map((panel) => (
        <button
          key={panel.id}
          type="button"
          role="tab"
          aria-selected={active === panel.id}
          className={`bridge-tab ${active === panel.id ? "active" : ""}`}
          onClick={() => onChange(panel.id)}
        >
          {panel.label}
          {panel.count != null && (
            <span className="bridge-tab-count">{panel.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}
