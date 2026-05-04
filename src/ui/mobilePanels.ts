import type { MainViewTab } from "./viewTabs";

export interface MobilePanelDef {
  id: string;
  label: string;
}

// Registry of mobile sub-panel tabs, keyed by main view tab. Each
// view's shell collapses to a single pane on mobile; the entries here
// drive the second tab strip (rendered in App.tsx, beneath the main
// view tabs) that lets the player pick which panel to view.
export const MOBILE_PANELS: Partial<Record<MainViewTab, readonly MobilePanelDef[]>> = {
  stocks: [
    { id: "listings", label: "Listings" },
    { id: "holdings", label: "Holdings" },
    { id: "detail", label: "Detail" },
  ],
  markets: [
    { id: "listings", label: "Listings" },
    { id: "detail", label: "Detail" },
  ],
  player: [
    { id: "fleet", label: "Fleet" },
    { id: "trade", label: "Trade" },
    { id: "info", label: "Info" },
    { id: "travel", label: "Travel" },
  ],
  locations: [
    { id: "map", label: "Map" },
    { id: "sheet", label: "Sheet" },
    { id: "detail", label: "Detail" },
  ],
  charters: [
    { id: "records", label: "Records" },
    { id: "career", label: "Career" },
  ],
};

export function defaultMobilePanelId(tab: MainViewTab): string | null {
  return MOBILE_PANELS[tab]?.[0]?.id ?? null;
}
