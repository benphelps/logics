// News events — a generic ticked-modifier layer that nudges math fields up
// or down for a bounded duration. Events spawn from a static pool (generated
// offline by the genNewsEvents CLI), are mean-reverting via per-scope bias,
// and short-circuit cleanly when world.newsEvents is undefined or disabled.
//
// Composition order: crew/upgrade modifiers are applied first (see crew.ts),
// then news events are applied as a final scalar at the consumer site.

import type { EquityId, GoodId, LocationId, SyndicateId } from "../types.js";

export type NewsScope =
  | "commodity_price"
  | "upgrade_cost"
  | "maintenance"
  | "crew_wage"
  | "docking_fee"
  | "contract_reward"
  | "treasury_replenish"
  | "treasury_yield"
  | "share_price_station"
  | "share_price_syndicate"
  | "commodity_index_price"
  | "basis_price"
  | "futures_price"
  | "dividend"
  // Multiplier on encounter spawn probability per transit tick. ctx.locationId
  // is the destination, ctx.syndicateId is the player's syndicate. Resolves to
  // 1 when no template references this scope (Phase 1 ships without templates).
  | "encounter_chance";

export type NewsTargetKind = "good" | "location" | "syndicate" | "index" | "global";

export interface NewsTarget {
  kind: NewsTargetKind;
  id?: string;        // GoodId | LocationId | SyndicateId | EquityId
  category?: string;  // good.category, or location faction, etc.
}

export interface NewsEffect {
  scope: NewsScope;
  target: NewsTarget;
  magnitude: number;     // 0..0.5 — clamped at consumer
  direction: 1 | -1;
}

export type NewsTone = "good" | "bad" | "warn" | "info";

export interface NewsEventTemplate {
  id: string;
  category: string;             // weather, politics, war, plague, festival, scandal, ...
  headline: string;             // may contain {station} {good} {syndicate} {person}
  body: string;
  effects: NewsEffect[];        // 1..3 effects; target.id may be empty (resolved at spawn)
  durationBand: "short" | "medium" | "long";
  magnitudeBand: "low" | "medium" | "high";
  followthroughOf?: string;     // template id of the prior event this follows from
  placeholderRequirements?: {
    station?: boolean;
    good?: boolean;
    syndicate?: boolean;
    person?: boolean;
  };
}

export interface ActiveNewsEvent {
  uid: string;                  // `news-{nextEventId}`, stable across saves
  templateId: string;
  spawnedAt: number;            // world.tick at spawn
  expiresAt: number;            // world.tick at which this event ends
  effects: NewsEffect[];        // resolved (concrete target ids, sampled magnitudes)
  headline: string;             // placeholders filled
  body: string;
  category: string;
  tone: NewsTone;
}

export interface RecentNewsEvent {
  uid: string;
  templateId: string;
  tick: number;                 // tick at which the event expired
  effects: NewsEffect[];
  // Carried forward from the active event so chart markers and history UIs
  // can show headline/tone/spawn-time after expiry. Optional for back-compat
  // with pre-existing saves and IDB rows.
  spawnedAt?: number;
  headline?: string;
  tone?: NewsTone;
}

export interface NewsEventsState {
  enabled: boolean;
  active: ActiveNewsEvent[];
  recent: RecentNewsEvent[];    // ring buffer for UI history
  bias: Record<string, number>; // scopeKey -> EMA of dir*magnitude
  nextEventId: number;
}

export interface NewsCtx {
  goodId?: GoodId;
  locationId?: LocationId;
  syndicateId?: SyndicateId;
  indexId?: EquityId;
  category?: string;
}
