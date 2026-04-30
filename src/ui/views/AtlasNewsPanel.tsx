import type { World } from "../../sim/types";
import type { ActiveNewsEvent, NewsEffect } from "../../sim/news/types";
import "./AtlasNewsPanel.css";

interface AtlasNewsPanelProps {
  world: World;
}

export function AtlasNewsPanel({ world }: AtlasNewsPanelProps) {
  const state = world.newsEvents;
  const active = state?.active ?? [];
  if (active.length === 0) {
    return (
      <div className="atlas-news-empty dim">
        No active world events. Conditions are stable across the sector.
      </div>
    );
  }

  const sorted = [...active].sort((a, b) => a.expiresAt - b.expiresAt);

  return (
    <ul className="atlas-news-list">
      {sorted.map((ev) => (
        <NewsRow key={ev.uid} ev={ev} world={world} />
      ))}
    </ul>
  );
}

function NewsRow({ ev, world }: { ev: ActiveNewsEvent; world: World }) {
  const lifeTotal = Math.max(1, ev.expiresAt - ev.spawnedAt);
  const lifeRemaining = Math.max(0, ev.expiresAt - world.tick);
  const fillPct = Math.max(0, Math.min(100, (lifeRemaining / lifeTotal) * 100));
  return (
    <li className={`atlas-news-row tone-${ev.tone}`}>
      <div className="atlas-news-row-head">
        <span className="atlas-news-tone" aria-hidden />
        <span className="atlas-news-cat">{ev.category}</span>
        <span className="atlas-news-headline">{ev.headline}</span>
        <span className="atlas-news-ticks">{lifeRemaining}t</span>
      </div>
      <div className="atlas-news-body">{ev.body}</div>
      <div className="atlas-news-effects">
        {ev.effects.map((eff, i) => (
          <span key={i} className="atlas-news-effect-chip">{describeEffect(eff, world)}</span>
        ))}
      </div>
      <div className="atlas-news-progress">
        <div className="atlas-news-progress-fill" style={{ width: `${fillPct}%` }} />
      </div>
    </li>
  );
}

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

function describeEffect(eff: NewsEffect, world: World): string {
  const scope = SCOPE_LABELS[eff.scope] ?? eff.scope;
  const arrow = eff.direction > 0 ? "↑" : "↓";
  const pct = `${Math.round(eff.magnitude * 100)}%`;
  const target = describeTarget(eff, world);
  return target ? `${target} ${scope} ${arrow}${pct}` : `${scope} ${arrow}${pct}`;
}

function describeTarget(eff: NewsEffect, world: World): string {
  const t = eff.target;
  if (t.kind === "global") return "all";
  if (t.kind === "good"      && t.id) return world.goods[t.id]?.name ?? t.id;
  if (t.kind === "good"      && t.category) return t.category;
  if (t.kind === "location"  && t.id) return world.locations[t.id]?.name ?? t.id;
  if (t.kind === "syndicate" && t.id) return world.syndicates[t.id]?.name ?? t.id;
  if (t.kind === "index"     && t.id) return world.equities[t.id]?.ticker ?? t.id;
  return "";
}
