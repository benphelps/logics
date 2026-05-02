// Shared types for view-local UI state the store + save layer both
// touch. Lives in its own module so saveGames.ts doesn't need to
// import the full store and trip a circular dependency.

export type FleetTab = "cargo" | "upgrades" | "crew" | "contracts";
export type CommodityTab = "all" | "food" | "raw" | "intermediate" | "luxury" | "fuel" | "advanced" | "upgrade";
export type PnoTab = "positions" | "orders" | "futures" | "history" | "insights";
export type AtlasSheetTab = "systems" | "ships" | "news";
export type AtlasMapTab = "stations" | "syndicates";
export type LedgerTab = "charters" | "syndicates";
export type StockKindFilter = "all" | "positions" | "station" | "syndicate" | "commodity" | "basis" | "futures" | "index";
export type MainViewTab = "player" | "markets" | "locations" | "stocks" | "charters";
export interface PanelScrollPosition {
  top: number;
  left: number;
}
export type PanelScrollPositions = Record<string, PanelScrollPosition>;

export interface ViewTabs {
  fleetTab: FleetTab;
  commodityTab: CommodityTab;
  pnoTab: PnoTab;
  atlasSheetTab: AtlasSheetTab;
  atlasMapTab: AtlasMapTab;
  ledgerTab: LedgerTab;
  stockKindFilter: StockKindFilter;
  stockGuideEnabled: boolean;
}

export const DEFAULT_VIEW_TABS: ViewTabs = {
  fleetTab: "cargo",
  commodityTab: "all",
  pnoTab: "positions",
  atlasSheetTab: "systems",
  atlasMapTab: "stations",
  ledgerTab: "charters",
  stockKindFilter: "all",
  stockGuideEnabled: false,
};

const FLEET_TABS: readonly FleetTab[] = ["cargo", "upgrades", "crew", "contracts"];
const COMMODITY_TABS: readonly CommodityTab[] = ["all", "food", "raw", "intermediate", "luxury", "fuel", "advanced", "upgrade"];
const PNO_TABS: readonly PnoTab[] = ["positions", "orders", "futures", "history", "insights"];
const ATLAS_SHEET_TABS: readonly AtlasSheetTab[] = ["systems", "ships", "news"];
const ATLAS_MAP_TABS: readonly AtlasMapTab[] = ["stations", "syndicates"];
const LEDGER_TABS: readonly LedgerTab[] = ["charters", "syndicates"];
const STOCK_KIND_FILTERS: readonly StockKindFilter[] = ["all", "positions", "station", "syndicate", "commodity", "basis", "futures", "index"];

export function normalizeViewTabs(input: unknown): ViewTabs {
  if (typeof input !== "object" || input === null) return { ...DEFAULT_VIEW_TABS };
  const v = input as Record<string, unknown>;
  return {
    fleetTab: pick(v.fleetTab, FLEET_TABS, DEFAULT_VIEW_TABS.fleetTab),
    commodityTab: pick(v.commodityTab, COMMODITY_TABS, DEFAULT_VIEW_TABS.commodityTab),
    pnoTab: pick(v.pnoTab, PNO_TABS, DEFAULT_VIEW_TABS.pnoTab),
    atlasSheetTab: pick(v.atlasSheetTab, ATLAS_SHEET_TABS, DEFAULT_VIEW_TABS.atlasSheetTab),
    atlasMapTab: pick(v.atlasMapTab, ATLAS_MAP_TABS, DEFAULT_VIEW_TABS.atlasMapTab),
    ledgerTab: pick(v.ledgerTab, LEDGER_TABS, DEFAULT_VIEW_TABS.ledgerTab),
    stockKindFilter: pick(v.stockKindFilter, STOCK_KIND_FILTERS, DEFAULT_VIEW_TABS.stockKindFilter),
    stockGuideEnabled: typeof v.stockGuideEnabled === "boolean" ? v.stockGuideEnabled : DEFAULT_VIEW_TABS.stockGuideEnabled,
  };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

export function normalizePanelScrollPositions(input: unknown): PanelScrollPositions {
  const positions: PanelScrollPositions = {};
  if (typeof input !== "object" || input === null) return positions;
  const v = input as Record<string, unknown>;
  for (const [key, raw] of Object.entries(v)) {
    if (!key) continue;
    if (typeof raw === "number" && Number.isFinite(raw)) {
      positions[key] = { top: Math.max(0, Math.round(raw)), left: 0 };
      continue;
    }
    if (typeof raw === "object" && raw !== null) {
      const value = raw as Record<string, unknown>;
      const top = typeof value.top === "number" && Number.isFinite(value.top)
        ? Math.max(0, Math.round(value.top))
        : 0;
      const left = typeof value.left === "number" && Number.isFinite(value.left)
        ? Math.max(0, Math.round(value.left))
        : 0;
      if (top > 0 || left > 0) positions[key] = { top, left };
    }
  }
  return positions;
}
