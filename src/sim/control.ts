import type { LocationId, SyndicateId, Trader, World } from "./types";

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

// Below this share, the entry drops out of the per-station map
// entirely. Keeps the control records compact and prevents long-tail
// noise from accumulating after a flip.
const MIN_SHARE = 0.0008;

// Cap how strong an individual nudge can land per call — prevents a
// single Ç1M trade from instantly flipping a station and bypassing the
// "play it through" feel of the system.
const MAX_NUDGE_PER_CALL = 0.18;

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
// dominant in the control map. The atlas legend, station detail panels,
// and CSS hooks all key off traits.faction, so flipping it here is what
// makes the dominance change visible to the rest of the UI.
function applyFactionFlips(world: World): boolean {
  if (!world.control) return false;
  let flipped = false;
  for (const locId in world.control) {
    const loc = world.locations[locId];
    if (!loc) continue;
    const { id: dominantId } = dominantOf(world.control[locId]);
    if (!dominantId) continue;
    if (loc.traits.faction !== dominantId) {
      loc.traits.faction = dominantId;
      flipped = true;
    }
  }
  return flipped;
}

// Per-tick housekeeping. Call once after trader events have been
// processed for the tick, and before persisting/rendering.
export function tickControl(world: World): void {
  let changed = applyDecay(world);
  if (applyFactionFlips(world)) changed = true;
  if (changed) bumpVersion(world);
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
  world.controlVersion = (world.controlVersion ?? 0) + 1;
}
