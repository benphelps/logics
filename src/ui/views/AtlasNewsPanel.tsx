import type { World } from "../../sim/types";
import type { ActiveNewsEvent } from "../../sim/news/types";
import { describeEffect } from "./newsHelpers";
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

