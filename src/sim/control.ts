import type { LocationId, SyndicateId, Trader, World } from "./types";
import type { ActiveNewsEvent, NewsEffect } from "./news/types";

// --- tunables ------------------------------------------------------------
// All in pre-normalize units. Each nudge() call applies the raw amount
// then renormalizes so the station's controls sum to 1 again — so the
// effective shift is always proportional to the station's current
// distribution. Numbers chosen so:
//   - a single NPC dock barely moves the dial
//   - a player who docks + trades twice can flip a 60/40 to 50/50
//   - sustained NPC activity from a rival syndicate visibly shifts a
//     border over a few hundred ticks
//
// `PLAYER_*` are ~8× the NPC counterparts, matching the user's spec
// ("npc and player actions move the map, player can simply move it
// more than NPCs").
export const NPC_DOCK_NUDGE = 0.0015;
export const PLAYER_DOCK_NUDGE = 0.012;
export const NPC_TRADE_PER_CREDIT = 8e-6;
export const PLAYER_TRADE_PER_CREDIT = 6e-5;

// Per-tick passive drift toward the current dominant syndicate at each
// station. Each non-dominant share loses this fraction; the slack
// returns to whoever's leading. Set to 0 — control changes only from
// real activity, no automatic reversion. Contested stations stay
// contested until somebody actually does something about them. Bump
// above 0 to add a slow consolidation pressure.
const DECAY_PER_TICK = 0;

// Per-tick pressure from nearby stations. A station surrounded by
// another syndicate's cluster gets pushed toward that syndicate by an
// amount that scales with how dominant the neighbour-syndicate is in
// the local area. Squared fraction means a 90%-dominant neighbour
// applies ~5× the pressure of a 40%-dominant one — clusters reinforce
// their own boundaries hard, so a lone foreign foothold doesn't sit
// stably for long.
const NEIGHBOR_PRESSURE_PER_TICK = 0.008;
// Neighbour radius as a fraction of the world's max-from-origin
// station distance. 30% covers the local cluster plus a sliver of
// adjacent ones at default scale.
const NEIGHBOR_RADIUS_FACTOR = 0.30;

// Consecutive ticks a rival must hold the dominant share before a
// station's faction actually flips. Provides hysteresis — a momentary
// burst of activity that pokes a rival above 50% won't snap the
// territory away from its long-running owner. The challenger has to
// sustain the lead. Reset when the previous owner reasserts dominance
// or a different rival overtakes the current challenger.
export const FLIP_HOLD_TICKS = 30;

// Below this share, the entry drops out of the per-station map
// entirely. Keeps the control records compact and prevents long-tail
// noise from accumulating after a flip.
const MIN_SHARE = 0.0008;

// Cap how strong an individual nudge can land per call — prevents a
// single Ç1M trade from instantly flipping a station and bypassing the
// "play it through" feel of the system.
const MAX_NUDGE_PER_CALL = 0.18;

// --- gameplay rates ----------------------------------------------------
// Crossing toll charged when a ship docks at a station owned by a
// different syndicate. Independent (shipyard / unfactioned) docks are
// always free; same-syndicate docks are always free. Toll flows to the
// foreign syndicate's treasury — closes the economic loop without
// creating a sink.
export const FOREIGN_DOCK_TOLL = 150;

// Buy / sell market bonuses when a ship trades at a station controlled
// by its own syndicate. Stack additively with the trader's existing
// crew + upgrade modifiers; the same 0.5 ceiling at the call site
// keeps the total fraction sane.
export const OWN_TERRITORY_BUY_BONUS = 0.03;
export const OWN_TERRITORY_SELL_BONUS = 0.03;

// Reputation gains per foreign-territory event. Player-only; NPCs don't
// accrue reputation. Tuned so a determined trader can earn full
// reputation with one foreign syndicate over ~30-40 visits, with trade
// volume contributing on top of pure dock count.
export const REP_PER_FOREIGN_DOCK = 0.025;
export const REP_PER_FOREIGN_CREDIT = 4e-6; // Ç1000 trade ≈ 0.004 rep

// --- core mutations -----------------------------------------------------

function ensureControlMap(world: World, locId: LocationId): Record<SyndicateId, number> | null {
  if (!world.locations[locId]) return null;
  if (!world.control) world.control = {};
  let m = world.control[locId];
  if (!m) {
    // Seed from the station's recorded faction at full strength. This
    // lazily migrates worlds that were saved before Phase 3, and gives
    // first-touch stations a sensible starting distribution.
    m = {};
    const owner = world.locations[locId].traits.faction;
    if (owner) m[owner] = 1.0;
    world.control[locId] = m;
  }
  return m;
}

function bumpVersion(world: World): void {
  world.controlVersion = (world.controlVersion ?? 0) + 1;
}

function normalize(m: Record<SyndicateId, number>): void {
  let sum = 0;
  for (const k in m) sum += m[k];
  if (sum <= 0) return;
  for (const k in m) {
    const v = m[k] / sum;
    if (v < MIN_SHARE) delete m[k];
    else m[k] = v;
  }
}

// Add `amount` to syndicate `syndId`'s control at station `locId`,
// then renormalize. Negative amounts allowed but clamped at 0. The
// effective shift is bounded by MAX_NUDGE_PER_CALL so a single huge
// trade can't single-handedly flip a station.
export function nudgeStationControl(
  world: World,
  locId: LocationId,
  syndId: SyndicateId,
  amount: number,
): void {
  if (amount === 0) return;
  // Cap magnitude per-call. Sign-preserving clamp.
  const clamped = Math.max(-MAX_NUDGE_PER_CALL, Math.min(MAX_NUDGE_PER_CALL, amount));
  const m = ensureControlMap(world, locId);
  if (!m) return;
  m[syndId] = Math.max(0, (m[syndId] ?? 0) + clamped);
  normalize(m);
  bumpVersion(world);
}

// Trader-aware convenience: applies a pre-weighted nudge to the trader's
// syndicate at the given station. Caller picks the weight from the
// exported constants based on whether this is a player ship — control.ts
// stays decoupled from the player-ship lookup rules. Ships without a
// syndicateId (old saves, unfactioned bootstrap ships) silently no-op.
export function creditActivity(
  world: World,
  trader: Trader,
  locId: LocationId,
  amount: number,
): void {
  const synd = trader.syndicateId;
  if (!synd || amount <= 0) return;
  nudgeStationControl(world, locId, synd, amount);
}

// --- per-tick housekeeping ----------------------------------------------

function dominantOf(m: Record<SyndicateId, number>): { id: SyndicateId | null; share: number } {
  let id: SyndicateId | null = null;
  let share = 0;
  for (const k in m) {
    if (m[k] > share) { share = m[k]; id = k; }
  }
  return { id, share };
}

// Decay non-dominant shares toward the current dominant. Stations being
// actively contested by external nudges race this passive drift; idle
// stations gradually consolidate around their leader.
function applyDecay(world: World): boolean {
  if (!world.control) return false;
  let changed = false;
  for (const locId in world.control) {
    const m = world.control[locId];
    const { id: dominantId } = dominantOf(m);
    if (!dominantId) continue;
    let recovered = 0;
    for (const k in m) {
      if (k === dominantId) continue;
      const lost = m[k] * DECAY_PER_TICK;
      if (lost <= 0) continue;
      m[k] -= lost;
      recovered += lost;
      if (m[k] < MIN_SHARE) delete m[k];
    }
    if (recovered > 0) {
      m[dominantId] = (m[dominantId] ?? 0) + recovered;
      changed = true;
    }
  }
  return changed;
}

// Sync each station's recorded faction stamp with whoever's actually
// dominant in the control map. Flips require sustained dominance —
// a rival who tops 50% has to hold the lead for FLIP_HOLD_TICKS
// consecutive ticks before the faction stamp changes hands. We track
// per-station challenger state in world.controlChallenge: ticksHeld
// counts up while the dominant != faction; resets when the owner
// reasserts or a different rival overtakes the current challenger.
// News events fire only at the moment of the actual flip.
function applyFactionFlips(world: World): { changed: boolean; spawned: ActiveNewsEvent[] } {
  if (!world.control) return { changed: false, spawned: [] };
  if (!world.controlChallenge) world.controlChallenge = {};
  const challenges = world.controlChallenge;
  let changed = false;
  const spawned: ActiveNewsEvent[] = [];

  for (const locId in world.control) {
    const loc = world.locations[locId];
    if (!loc) continue;
    const { id: dominantId } = dominantOf(world.control[locId]);
    if (!dominantId) {
      if (challenges[locId]) delete challenges[locId];
      continue;
    }

    const previous = loc.traits.faction;

    // First-time stamp on a station that had no faction yet: settle
    // immediately (no incumbent to defend against). Mostly hits old
    // saves and post-gen worlds where the seed populated control with
    // an entry but the loc.traits.faction got lost.
    if (!previous) {
      loc.traits.faction = dominantId;
      changed = true;
      delete challenges[locId];
      continue;
    }

    if (previous === dominantId) {
      // Owner is still dominant — no challenge in progress.
      if (challenges[locId]) delete challenges[locId];
      continue;
    }

    // Different syndicate is dominant. Tick the challenger or start a
    // fresh count when the lead changes hands.
    const existing = challenges[locId];
    if (existing && existing.syndicateId === dominantId) {
      existing.ticksHeld += 1;
    } else {
      challenges[locId] = { syndicateId: dominantId, ticksHeld: 1 };
    }

    const challenger = challenges[locId];
    if (challenger.ticksHeld >= FLIP_HOLD_TICKS) {
      loc.traits.faction = dominantId;
      changed = true;
      delete challenges[locId];
      const ev = makeFlipEvent(world, locId, previous, dominantId);
      if (ev) {
        spawned.push(ev);
        if (world.newsEvents) world.newsEvents.active.push(ev);
      }
    }
  }
  return { changed, spawned };
}

// Build the news event for a station-flip: a short-duration buff to the
// seizing syndicate's share-price signal and a matching debuff to the
// previous owner's. The toast pipeline picks these up via tickWorld's
// newsSpawned aggregation.
function makeFlipEvent(
  world: World,
  locId: LocationId,
  previousId: SyndicateId,
  newId: SyndicateId,
): ActiveNewsEvent | null {
  const loc = world.locations[locId];
  const newSynd = world.syndicates[newId];
  const prevSynd = world.syndicates[previousId];
  if (!loc || !newSynd || !prevSynd) return null;
  const FLIP_DURATION = 8;
  const FLIP_MAGNITUDE = 0.06;
  const effects: NewsEffect[] = [
    { scope: "share_price_syndicate", target: { kind: "syndicate", id: newId },      magnitude: FLIP_MAGNITUDE, direction: 1 },
    { scope: "share_price_syndicate", target: { kind: "syndicate", id: previousId }, magnitude: FLIP_MAGNITUDE, direction: -1 },
  ];
  const id = world.newsEvents ? world.newsEvents.nextEventId++ : 1;
  return {
    uid: `flip-${id}`,
    templateId: "station_flip",
    spawnedAt: world.tick,
    expiresAt: world.tick + FLIP_DURATION,
    effects,
    headline: `${newSynd.name} seizes ${loc.name}`,
    body: `Operations transfer from ${prevSynd.name}. New docking arrangements at the station are already in effect.`,
    category: "war",
    tone: "warn",
  };
}

export interface ControlTickReport {
  spawnedNews: ActiveNewsEvent[];
}

// Apply per-tick neighbour-station pressure: each station is nudged
// toward whichever syndicates dominate its surrounding cluster. The
// fraction² weighting means a station deep inside a rival cluster
// drifts hard, while a station inside its own cluster mostly gets
// reinforcing nudges from itself.
function applyNeighborPressure(world: World): boolean {
  if (!world.control) return false;
  const locs = Object.values(world.locations);
  if (locs.length === 0) return false;

  // Approx world radius — distance from origin to the farthest station.
  // Cheap to recompute each tick at our scales; would memoise if we
  // started seeing it in profiles.
  let maxR = 0;
  for (const loc of locs) {
    const r = Math.hypot(loc.position.x, loc.position.y);
    if (r > maxR) maxR = r;
  }
  if (maxR <= 0) return false;
  const radius = maxR * NEIGHBOR_RADIUS_FACTOR;
  const radiusSq = radius * radius;

  let changed = false;
  for (const loc of locs) {
    // Shipyards are intentionally unfactioned — skip them as both
    // pressure source (they emit nothing) and target (they don't
    // get pushed). Untargetable here keeps the source loop honest.
    if (loc.traits.tags.includes("shipyard")) continue;
    const pressure: Record<SyndicateId, number> = {};
    let totalWeight = 0;
    for (const other of locs) {
      if (other.id === loc.id) continue;
      const f = other.traits.faction;
      if (!f) continue;
      const dx = other.position.x - loc.position.x;
      const dy = other.position.y - loc.position.y;
      const distSq = dx * dx + dy * dy;
      if (distSq > radiusSq) continue;
      // Inverse-square weighting (with floor) so closer neighbours
      // pull harder than distant ones.
      const weight = 1 / (distSq + 1);
      pressure[f] = (pressure[f] ?? 0) + weight;
      totalWeight += weight;
    }
    if (totalWeight === 0) continue;
    for (const synd in pressure) {
      const fraction = pressure[synd] / totalWeight;
      const amplified = fraction * fraction;
      nudgeStationControl(world, loc.id, synd, amplified * NEIGHBOR_PRESSURE_PER_TICK);
      changed = true;
    }
  }
  return changed;
}

// Per-tick housekeeping. Call once after trader events have been
// processed for the tick, and before persisting/rendering. Returns the
// news events spawned by faction flips so tickWorld can fold them into
// its tick report (and the toast pipeline can surface them).
export function tickControl(world: World): ControlTickReport {
  let changed = applyDecay(world);
  if (applyNeighborPressure(world)) changed = true;
  const flips = applyFactionFlips(world);
  if (flips.changed) changed = true;
  if (changed) bumpVersion(world);
  return { spawnedNews: flips.spawned };
}

// --- reputation ----------------------------------------------------------

// Reputation read with sensible defaults. Returns 0 for any syndicate
// the player has never interacted with — and the caller treats that as
// "no discount, full toll".
export function playerReputationWith(world: World, syndicateId: SyndicateId): number {
  return world.player?.reputation?.[syndicateId] ?? 0;
}

// Bump player reputation with a syndicate by `amount`, clamped 0..1.
// No-ops if there's no player or the syndicate doesn't exist. Caller
// is responsible for gating to player-only events.
export function bumpPlayerReputation(world: World, syndicateId: SyndicateId, amount: number): void {
  if (!world.player || amount === 0) return;
  if (!world.syndicates[syndicateId]) return;
  if (!world.player.reputation) world.player.reputation = {};
  const cur = world.player.reputation[syndicateId] ?? 0;
  world.player.reputation[syndicateId] = Math.max(0, Math.min(1, cur + amount));
}

// Effective toll after reputation discount. Plain function — pure of
// the trader's player-status (caller passes isPlayer when applicable).
// At rep=1.0 the player pays nothing; at rep=0 they pay full freight.
// NPCs always pay the base toll regardless of any player rep state.
export function effectiveToll(world: World, syndicateId: SyndicateId, isPlayer: boolean): number {
  if (!isPlayer) return FOREIGN_DOCK_TOLL;
  const rep = playerReputationWith(world, syndicateId);
  return Math.max(0, FOREIGN_DOCK_TOLL * (1 - rep));
}

// --- territory queries (used by toll + bonus call sites) ---------------

// True when the trader's syndicate matches the dominant syndicate at
// its current location. Shipyards and unfactioned stations always
// return false — there's no "own territory" relationship to check.
export function isOwnTerritory(world: World, trader: Trader): boolean {
  const synd = trader.syndicateId;
  if (!synd) return false;
  const here = world.locations[trader.location];
  return here?.traits.faction === synd;
}

export function territoryBuyBonus(world: World, trader: Trader): number {
  return isOwnTerritory(world, trader) ? OWN_TERRITORY_BUY_BONUS : 0;
}

export function territorySellBonus(world: World, trader: Trader): number {
  return isOwnTerritory(world, trader) ? OWN_TERRITORY_SELL_BONUS : 0;
}

// Compute the toll for a trader docking at its current location.
// Returns { fee: 0 } when the toll doesn't apply — caller should still
// pass the result through to the deducting helper, which handles the
// no-op case cleanly.
export function tollForArrival(
  world: World,
  trader: Trader,
): { fee: number; toSyndicate: SyndicateId | null } {
  const here = world.locations[trader.location];
  if (!here) return { fee: 0, toSyndicate: null };
  const stationFaction = here.traits.faction;
  // Independent ports (shipyards, gen-time unfactioned) charge no toll.
  if (!stationFaction) return { fee: 0, toSyndicate: null };
  // Own-syndicate or unaffiliated traders pay nothing — only foreign
  // ships from a real syndicate get tolled.
  const traderSynd = trader.syndicateId;
  if (!traderSynd || traderSynd === stationFaction) return { fee: 0, toSyndicate: null };
  return { fee: FOREIGN_DOCK_TOLL, toSyndicate: stationFaction };
}

// Initialize the control map from the world's current faction stamps —
// every stamped station gets a 1.0 share to its owner. Called from
// gen/world.ts after Pass 3 (faction assignment) so a brand-new world
// has a fully-populated control state ready for the renderer to read.
export function seedControlFromFactions(world: World): void {
  const control: Record<LocationId, Record<SyndicateId, number>> = {};
  for (const loc of Object.values(world.locations)) {
    const owner = loc.traits.faction;
    if (!owner) continue;
    control[loc.id] = { [owner]: 1.0 };
  }
  world.control = control;
  world.controlChallenge = {};
  world.controlVersion = (world.controlVersion ?? 0) + 1;
}
