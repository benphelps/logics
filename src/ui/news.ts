// Client-side news fetcher. Talks to the dev/prod /api/news/* endpoints
// to (a) generate the per-game UniverseBackstory at new-game time, and
// (b) generate one news event when the spawn cadence requests it.
//
// Reads from / mutates world.newsEvents directly via callbacks the store
// passes in. Doesn't own a cache — the server side caches the backstory
// per gameId, and events are unique per call so caching them client-side
// would just delay the next interesting beat.

import type { UniverseBackstory, World } from "../sim/types";
import type {
  ActiveNewsEvent,
  NewsBiasHint,
  NewsEffect,
  NewsSpawnRequest,
  NewsTarget,
  ResolvedNewsEvent,
} from "../sim/news";
import { applyResolvedNewsEvent, MAX_INFLIGHT_REQUESTS } from "../sim/news";

// Client-side concurrency cap for /api/news/event. The sim emits cadence-
// driven requests freely (it doesn't know about HTTP), and we drop spawn
// requests on the floor here when this counter is already at the cap.
// Module-level so the cap survives store re-creation but resets on page
// reload (which is fine — load doesn't carry in-flight requests anyway).
let inflightRequests = 0;

interface BackstoryEndpointResult {
  backstory: UniverseBackstory;
  cached: boolean;
}

interface EventEndpointResult {
  event: {
    headline: string;
    body: string;
    tone: string;
    category: string;
    durationBand: "short" | "medium" | "long";
    magnitudeBand: "low" | "medium" | "high";
    effects: Array<{
      scope: string;
      target: NewsTarget;
      direction: 1 | -1;
      magnitude: number;
    }>;
  };
}

// --- backstory ----------------------------------------------------------

export interface BackstoryRequestInput {
  gameId: string;
  syndicates: { id: string; name: string; trait?: string; accentHex?: string }[];
  locations: { id: string; name: string; faction?: string; population?: number; tags?: string[] }[];
  tone?: string;
}

export async function fetchUniverseBackstory(input: BackstoryRequestInput): Promise<UniverseBackstory> {
  const res = await fetch("/api/news/backstory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Backstory request failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json() as BackstoryEndpointResult;
  return { ...data.backstory, generatedAt: Date.now() };
}

// Procedural fallback when the API is unavailable (no key, network down,
// etc.). Keeps the game playable without lore — the player just doesn't
// see headlines reference universe history. Generic enough to read as
// "default sector" without claiming concrete proper nouns.
export function fallbackUniverseBackstory(): UniverseBackstory {
  return {
    tagline: "Charter syndicates run the haulers; everyone else runs from them.",
    era: "Late Charter Era",
    political: "The five charter syndicates hold the lanes between trade hubs but are perpetually short of trust. Border stations sway between flags as coalitions form, dissolve, and re-form on each fiscal quarter.",
    economic: "Bulk feedstocks move on long established routes; advanced goods cluster around the high-tech research stations. Shortages flare unpredictably as production hubs trade favours rather than commodities.",
    tensions: "An undeclared shadow war over commodity contracts simmers along contested borders. Privateers exploit the gaps; patrol fleets exploit the privateers; nobody wins twice in a row.",
    timelineBeats: [],
    generatedAt: Date.now(),
  };
}

// --- event generation ---------------------------------------------------

interface EventRequestPayload {
  gameId: string;
  backstory: UniverseBackstory;
  target: NewsTarget & { label?: string };
  recentEvents: { headline: string; tone?: string; tick: number }[];
  worldSignals?: Record<string, unknown>;
  biasHint: NewsBiasHint;
  tickNow: number;
}

// Fire an event request. On success, applies it via the sim's
// applyResolvedNewsEvent. On failure, just decrements the in-flight
// counter — the next cadence will roll again. Returns the applied event
// (for the store's toast pipeline) or null on failure / no-spawn /
// concurrency cap.
export async function fetchNewsEvent(
  world: World,
  request: NewsSpawnRequest,
  gameId: string,
): Promise<ActiveNewsEvent | null> {
  const state = world.newsEvents;
  if (!state) return null;
  if (inflightRequests >= MAX_INFLIGHT_REQUESTS) return null;
  inflightRequests += 1;
  const backstory = world.universeBackstory ?? fallbackUniverseBackstory();
  const recent = collectRecentForTarget(world, request.target).slice(-3).map(e => ({
    headline: e.headline,
    tone: e.tone,
    tick: e.spawnedAt,
  }));
  const payload: EventRequestPayload = {
    gameId,
    backstory,
    target: { ...request.target, label: request.label },
    recentEvents: recent,
    worldSignals: collectWorldSignals(world, request.target),
    biasHint: request.biasHint,
    tickNow: world.tick,
  };

  try {
    const res = await fetch("/api/news/event", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.warn("[ledgway] news event request failed", res.status, text.slice(0, 200));
      return null;
    }
    const data = await res.json() as EventEndpointResult;
    const resolved: ResolvedNewsEvent = {
      headline: data.event.headline,
      body: data.event.body,
      tone: data.event.tone,
      category: data.event.category,
      durationBand: data.event.durationBand,
      magnitudeBand: data.event.magnitudeBand,
      effects: data.event.effects.map((e): NewsEffect => ({
        scope: e.scope as NewsEffect["scope"],
        target: e.target,
        direction: e.direction,
        magnitude: e.magnitude,
      })),
    };
    // Pass the spawn request's target as the apply-time fallback so any
    // hallucinated target ids on the model side get replaced with the
    // intended target (which we picked from world state and know resolves).
    return applyResolvedNewsEvent(world, resolved, request.target);
  } catch (err) {
    console.warn("[ledgway] news event request error", err);
    return null;
  } finally {
    if (inflightRequests > 0) inflightRequests -= 1;
  }
}

// --- helpers ------------------------------------------------------------

// Pick the recent events that affect the same target as the request, so
// the LLM can write a follow-up thread instead of a fresh non-sequitur.
function collectRecentForTarget(world: World, target: NewsTarget): ActiveNewsEvent[] {
  const recent = world.newsEvents?.recent ?? [];
  const active = world.newsEvents?.active ?? [];
  const out: ActiveNewsEvent[] = [];
  for (const ev of [...recent, ...active]) {
    if (!("headline" in ev) || !("body" in ev)) continue;
    const concrete = ev as ActiveNewsEvent;
    if (concrete.effects.some(eff => effectMatchesTarget(eff, target))) {
      out.push(concrete);
    }
  }
  return out;
}

function effectMatchesTarget(eff: NewsEffect, target: NewsTarget): boolean {
  if (eff.target.kind !== target.kind) return false;
  if (target.kind === "global") return true;
  if (target.id) return eff.target.id === target.id;
  if (target.category) return eff.target.category === target.category;
  return false;
}

// Slice of world state that's relevant to the LLM for this target. Kept
// small so the prompt stays tight.
function collectWorldSignals(world: World, target: NewsTarget): Record<string, unknown> {
  const signals: Record<string, unknown> = { tick: world.tick };
  if (target.kind === "location" && target.id) {
    const loc = world.locations[target.id];
    const market = world.markets[target.id];
    if (loc) {
      signals.station = {
        name: loc.name,
        faction: loc.traits.faction,
        population: loc.population,
        tags: loc.traits.tags,
      };
    }
    if (market) {
      signals.treasury = Math.round(market.treasury);
      signals.treasuryTarget = Math.round(market.treasuryTarget);
    }
  }
  if (target.kind === "syndicate" && target.id) {
    const synd = world.syndicates[target.id];
    if (synd) {
      signals.syndicate = {
        name: synd.name,
        treasury: Math.round(synd.treasury),
        recentRevenue: Math.round(synd.recentRevenue),
      };
    }
  }
  if (target.kind === "good" && target.id) {
    const good = world.goods[target.id];
    if (good) {
      signals.good = {
        name: good.name,
        category: good.category,
        basePrice: good.basePrice,
      };
    }
  }
  return signals;
}
