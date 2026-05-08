import type { Equity, World } from "../../sim/types";
import type { NewsEffect, NewsTone } from "../../sim/news/types";

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

export interface EquityNewsMarker {
  uid: string;
  spawnedAt: number;
  expiresAt: number | null;     // null when the event has already expired
  headline: string;
  tone: NewsTone;
  direction: 1 | -1;
}

// News events that hit this equity's underlying. Phase 1: only station and
// syndicate equities, mapped through share_price_station / share_price_syndicate.
// Pulls from active + recent buffers; recent events fall back to expiry tick
// when spawnedAt wasn't recorded (older saves), since RecentNewsEvent only
// recently grew those fields.
export function listEquityNewsMarkers(eq: Equity, world: World): EquityNewsMarker[] {
  const ns = world.newsEvents;
  if (!ns) return [];
  const wantedScope =
    eq.kind === "station"   ? "share_price_station" :
    eq.kind === "syndicate" ? "share_price_syndicate" :
    null;
  if (!wantedScope) return [];
  const wantedTargetKind = eq.kind === "station" ? "location" : "syndicate";

  const out: EquityNewsMarker[] = [];
  for (const ev of ns.active) {
    const eff = ev.effects.find(
      e => e.scope === wantedScope && e.target.kind === wantedTargetKind && e.target.id === eq.underlyingId
    );
    if (!eff) continue;
    out.push({
      uid: ev.uid,
      spawnedAt: ev.spawnedAt,
      expiresAt: ev.expiresAt,
      headline: ev.headline,
      tone: ev.tone,
      direction: eff.direction,
    });
  }
  for (const ev of ns.recent) {
    const eff = ev.effects.find(
      e => e.scope === wantedScope && e.target.kind === wantedTargetKind && e.target.id === eq.underlyingId
    );
    if (!eff) continue;
    out.push({
      uid: ev.uid,
      spawnedAt: ev.spawnedAt ?? ev.tick,
      expiresAt: null,
      headline: ev.headline ?? "",
      tone: ev.tone ?? "info",
      direction: eff.direction,
    });
  }
  return out;
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
