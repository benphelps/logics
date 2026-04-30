// Shared types for the inner view tabs the store + save layer both
// touch. Lives in its own module so saveGames.ts doesn't need to
// import the full store and trip a circular dependency.

export type FleetTab = "cargo" | "upgrades" | "crew" | "contracts";
export type CommodityTab = "all" | "food" | "raw" | "intermediate" | "luxury" | "fuel" | "advanced" | "upgrade";
export type PnoTab = "positions" | "orders" | "futures" | "history";

export interface ViewTabs {
  fleetTab: FleetTab;
  commodityTab: CommodityTab;
  pnoTab: PnoTab;
}

export const DEFAULT_VIEW_TABS: ViewTabs = {
  fleetTab: "cargo",
  commodityTab: "all",
  pnoTab: "positions",
};

const FLEET_TABS: readonly FleetTab[] = ["cargo", "upgrades", "crew", "contracts"];
const COMMODITY_TABS: readonly CommodityTab[] = ["all", "food", "raw", "intermediate", "luxury", "fuel", "advanced", "upgrade"];
const PNO_TABS: readonly PnoTab[] = ["positions", "orders", "futures", "history"];

export function normalizeViewTabs(input: unknown): ViewTabs {
  if (typeof input !== "object" || input === null) return { ...DEFAULT_VIEW_TABS };
  const v = input as Record<string, unknown>;
  return {
    fleetTab: pick(v.fleetTab, FLEET_TABS, DEFAULT_VIEW_TABS.fleetTab),
    commodityTab: pick(v.commodityTab, COMMODITY_TABS, DEFAULT_VIEW_TABS.commodityTab),
    pnoTab: pick(v.pnoTab, PNO_TABS, DEFAULT_VIEW_TABS.pnoTab),
  };
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}
