import type { World } from "../../sim/types";
import type { NewsEffect } from "../../sim/news/types";

const SCOPE_LABELS: Record<string, string> = {
  commodity_price: "price",
  upgrade_cost: "upgrades",
  maintenance: "upkeep",
  crew_wage: "wages",
  docking_fee: "docking",
  contract_reward: "contracts",
  treasury_replenish: "treasury",
  treasury_yield: "yield",
  share_price_station: "stock",
  share_price_syndicate: "stock",
  commodity_index_price: "index",
  basis_price: "basis",
  futures_price: "futures",
  dividend: "dividend",
};

export function describeEffect(eff: NewsEffect, world: World): string {
  const scope = SCOPE_LABELS[eff.scope] ?? eff.scope;
  const arrow = eff.direction > 0 ? "↑" : "↓";
  const pct = `${Math.round(eff.magnitude * 100)}%`;
  const target = describeTarget(eff, world);
  return target ? `${target} ${scope} ${arrow}${pct}` : `${scope} ${arrow}${pct}`;
}

export function describeTarget(eff: NewsEffect, world: World): string {
  const t = eff.target;
  if (t.kind === "global") return "all";
  if (t.kind === "good"      && t.id) return world.goods[t.id]?.name ?? t.id;
  if (t.kind === "good"      && t.category) return t.category;
  if (t.kind === "location"  && t.id) return world.locations[t.id]?.name ?? t.id;
  if (t.kind === "syndicate" && t.id) return world.syndicates[t.id]?.name ?? t.id;
  if (t.kind === "index"     && t.id) return world.equities[t.id]?.ticker ?? t.id;
  return "";
}
