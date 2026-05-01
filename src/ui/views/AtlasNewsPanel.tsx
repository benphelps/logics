import type { LocationId, World } from "../../sim/types";
import type { ActiveNewsEvent } from "../../sim/news/types";
import { describeEffect } from "./newsHelpers";
import "./AtlasNewsPanel.css";

interface AtlasNewsPanelProps {
  world: World;
  onSelectLocation?: (id: LocationId) => void;
}

export function AtlasNewsPanel({ world, onSelectLocation }: AtlasNewsPanelProps) {
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
        <NewsRow key={ev.uid} ev={ev} world={world} onSelectLocation={onSelectLocation} />
      ))}
    </ul>
  );
}

function NewsRow({ ev, world, onSelectLocation }: {
  ev: ActiveNewsEvent;
  world: World;
  onSelectLocation?: (id: LocationId) => void;
}) {
  const lifeTotal = Math.max(1, ev.expiresAt - ev.spawnedAt);
  const lifeRemaining = Math.max(0, ev.expiresAt - world.tick);
  const fillPct = Math.max(0, Math.min(100, (lifeRemaining / lifeTotal) * 100));
  // Surface the first location-targeted effect so the row can jump to
  // the affected station. Falls back to the first good's most-pressured
  // station if no explicit location target is on the event.
  const targetLocId = newsRowTargetLocation(ev, world);
  const clickable = targetLocId != null && onSelectLocation != null;
  const handleClick = () => {
    if (clickable) onSelectLocation!(targetLocId!);
  };
  return (
    <li
      className={`atlas-news-row tone-${ev.tone} ${clickable ? "clickable" : ""}`}
      role={clickable ? "button" : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? handleClick : undefined}
      onKeyDown={clickable ? (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          handleClick();
        }
      } : undefined}
      title={clickable ? `Inspect ${world.locations[targetLocId!]?.name ?? targetLocId}` : undefined}
    >
      <div className="atlas-news-eyebrow">
        <span className="atlas-news-tone" aria-hidden />
        <span className="atlas-news-cat">{ev.category}</span>
        <span className="atlas-news-ticks">{lifeRemaining}t</span>
      </div>
      <div className="atlas-news-headline">{ev.headline}</div>
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

function newsRowTargetLocation(ev: ActiveNewsEvent, world: World): LocationId | null {
  const explicit = ev.effects.find(eff => eff.target.kind === "location" && eff.target.id);
  if (explicit?.target.id && world.locations[explicit.target.id]) return explicit.target.id;
  // Good-targeted: pick the station with the largest absolute net-trade
  // exposure to that good, so the user lands on a place this event
  // actually moves the needle for.
  const goodEffect = ev.effects.find(eff => eff.target.kind === "good" && eff.target.id);
  const goodId = goodEffect?.target.id;
  if (!goodId) return null;
  let best: { locId: LocationId; score: number } | null = null;
  for (const loc of Object.values(world.locations)) {
    const produced = loc.produces.find(p => p.good === goodId)?.ratePerTick ?? 0;
    const consumed = loc.consumes.find(c => c.good === goodId)?.ratePerTick ?? 0;
    const score = Math.abs(produced - consumed);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { locId: loc.id, score };
  }
  return best?.locId ?? null;
}

