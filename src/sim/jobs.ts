import type { GoodId, Job, JobId, JobKind, JobTier, LocationId, Trader, TraderId, World } from "./types";
import { pushJobAbandoned, pushJobAccepted, pushJobCompleted, pushJobExpired } from "./log";

// --- tunables --------------------------------------------------------------

export const MAX_OPEN_JOBS = 24;            // cap total board size (active + available)

// Shortage tier from severity (stock / target)
export const SHORTAGE_HIGH_FRACTION = 0.05;
export const SHORTAGE_MED_FRACTION = 0.20;
export const SHORTAGE_LOW_FRACTION = 0.45;  // posts up to this fraction; below = consider posting

// Rescue tier from how long the trader has been stranded (in ticks)
export const RESCUE_HIGH_TICKS = 10;
export const RESCUE_MED_TICKS = 4;

// Reward = qty * basePrice * REWARD_MULT_BY_TIER
export const REWARD_MULT_BY_TIER: Record<JobTier, number> = { low: 1.6, medium: 2.5, high: 4.0 };

// Penalty (cash) on failure (expiry-after-accepted or abandon-after-accepted) =
// PENALTY_FRACTION * reward
export const PENALTY_FRACTION_BY_TIER: Record<JobTier, number> = { low: 0, medium: 0.25, high: 1.0 };

// Expiry window from time of posting (ticks). High-tier jobs are urgent; low can sit.
export const EXPIRY_TICKS_BY_TIER: Record<JobTier, number> = { low: 120, medium: 60, high: 30 };

// Quantity = SHORTAGE_QTY_FRACTION * (target - currentStock), capped at SHORTAGE_QTY_MAX
export const SHORTAGE_QTY_FRACTION = 0.5;
export const SHORTAGE_QTY_MAX = 80;
export const SHORTAGE_QTY_MIN = 5;

// Rescue: deliver qty fuel = RESCUE_FUEL_FRACTION * trader.fuelCapacity
export const RESCUE_FUEL_FRACTION = 0.5;

// --- helpers ---------------------------------------------------------------

function makeJobId(world: World): JobId {
  const id = `j${world.nextJobId}`;
  world.nextJobId += 1;
  return id;
}

function tierForShortage(stock: number, target: number): JobTier | null {
  if (target <= 0) return null;
  const frac = stock / target;
  if (frac < SHORTAGE_HIGH_FRACTION) return "high";
  if (frac < SHORTAGE_MED_FRACTION) return "medium";
  if (frac < SHORTAGE_LOW_FRACTION) return "low";
  return null;
}

function tierForRescue(stuckTicks: number): JobTier {
  if (stuckTicks >= RESCUE_HIGH_TICKS) return "high";
  if (stuckTicks >= RESCUE_MED_TICKS) return "medium";
  return "low";
}

function buildJobIndex(world: World): Set<string> {
  const set = new Set<string>();
  for (const j of Object.values(world.jobs)) set.add(`${j.kind}|${j.destination}|${j.good}`);
  return set;
}

function isPlayerShip(world: World, traderId: TraderId | null | undefined): boolean {
  if (!traderId || !world.player) return false;
  return world.player.shipIds.includes(traderId);
}

// --- generation ------------------------------------------------------------

export function generateJobs(world: World): Job[] {
  const openCount = Object.keys(world.jobs).length;
  if (openCount >= MAX_OPEN_JOBS) return [];
  const posted: Job[] = [];
  const index = buildJobIndex(world);
  const totalOpen = () => openCount + posted.length;

  // 1) Shortages — scan markets for stock far below target on consumed goods
  for (const loc of Object.values(world.locations)) {
    if (totalOpen() >= MAX_OPEN_JOBS) break;
    const market = world.markets[loc.id];
    for (const consumed of loc.consumes) {
      if (totalOpen() >= MAX_OPEN_JOBS) break;
      const target = loc.targetStock[consumed.good] ?? 0;
      if (target <= 0) continue;
      const stock = market.stock[consumed.good] ?? 0;
      const tier = tierForShortage(stock, target);
      if (!tier) continue;
      if (index.has(`shortage|${loc.id}|${consumed.good}`)) continue;

      const deficit = Math.max(0, target - stock);
      const qty = Math.max(SHORTAGE_QTY_MIN, Math.min(SHORTAGE_QTY_MAX, Math.floor(deficit * SHORTAGE_QTY_FRACTION)));
      if (qty < SHORTAGE_QTY_MIN) continue;

      const good = world.goods[consumed.good];
      if (!good) continue;
      const reward = Math.round(qty * good.basePrice * REWARD_MULT_BY_TIER[tier]);
      const penalty = Math.round(reward * PENALTY_FRACTION_BY_TIER[tier]);
      const job: Job = {
        id: makeJobId(world),
        kind: "shortage",
        tier,
        good: consumed.good,
        qty,
        destination: loc.id,
        reward,
        penalty,
        postedTick: world.tick,
        expiresAt: world.tick + EXPIRY_TICKS_BY_TIER[tier],
        acceptedBy: null,
        delivered: 0,
      };
      world.jobs[job.id] = job;
      index.add(`shortage|${loc.id}|${consumed.good}`);
      posted.push(job);
    }
  }

  // 2) Rescues — NPC traders that have been stuck for at least one full tick
  for (const trader of Object.values(world.traders)) {
    if (totalOpen() >= MAX_OPEN_JOBS) break;
    if (isPlayerShip(world, trader.id)) continue;
    if ((trader.stuckTicks ?? 0) <= 0) continue;
    if (trader.fuelTypes.length === 0) continue;
    const fuelGood = trader.fuelTypes[0].good;
    if (index.has(`rescue|${trader.location}|${fuelGood}`)) continue;

    const tier = tierForRescue(trader.stuckTicks ?? 0);
    const qty = Math.max(SHORTAGE_QTY_MIN, Math.floor(trader.fuelCapacity * RESCUE_FUEL_FRACTION));
    const fuel = world.goods[fuelGood];
    if (!fuel) continue;
    const reward = Math.round(qty * fuel.basePrice * REWARD_MULT_BY_TIER[tier]);
    const penalty = Math.round(reward * PENALTY_FRACTION_BY_TIER[tier]);
    const job: Job = {
      id: makeJobId(world),
      kind: "rescue",
      tier,
      good: fuelGood,
      qty,
      destination: trader.location,
      reward,
      penalty,
      postedTick: world.tick,
      expiresAt: world.tick + EXPIRY_TICKS_BY_TIER[tier],
      acceptedBy: null,
      delivered: 0,
      rescueTarget: trader.id,
    };
    world.jobs[job.id] = job;
    index.add(`rescue|${trader.location}|${fuelGood}`);
    posted.push(job);
  }

  return posted;
}

// --- expiry ----------------------------------------------------------------

export interface JobExpiryEvent {
  jobId: JobId;
  tier: JobTier;
  acceptedBy: TraderId | null;
  penalty: number;
}

// Remove jobs past their deadline. If the job was accepted, charge the penalty
// against the player's bank — that's how high-tier jobs hurt to fail.
export function expireJobs(world: World): JobExpiryEvent[] {
  const events: JobExpiryEvent[] = [];
  for (const job of Object.values(world.jobs)) {
    if (world.tick < job.expiresAt) continue;
    const acceptingShip = job.acceptedBy ? world.traders[job.acceptedBy] : null;
    const penalty = acceptingShip ? job.penalty : 0;
    if (acceptingShip && world.player && job.penalty > 0) {
      world.player.funds -= job.penalty;
    }
    if (acceptingShip) pushJobExpired(world, acceptingShip, job, penalty);
    events.push({ jobId: job.id, tier: job.tier, acceptedBy: job.acceptedBy, penalty });
    delete world.jobs[job.id];
  }
  return events;
}

// --- acceptance / abandonment ---------------------------------------------

export type JobActionResult = { ok: true } | { ok: false; reason: string };

export function acceptJob(world: World, jobId: JobId, traderId: TraderId): JobActionResult {
  const job = world.jobs[jobId];
  if (!job) return { ok: false, reason: "Job no longer available." };
  if (job.acceptedBy != null) return { ok: false, reason: "Job already accepted." };
  const ship = world.traders[traderId];
  if (!ship) return { ok: false, reason: "Unknown ship." };
  if (!isPlayerShip(world, traderId)) return { ok: false, reason: "Only player ships can accept jobs." };
  job.acceptedBy = traderId;
  pushJobAccepted(world, ship, job);
  return { ok: true };
}

// Abandoning an accepted job charges the failure penalty (same as expiry).
// For an unaccepted job (clearing it from the board), just remove it freely.
export function abandonJob(world: World, jobId: JobId): JobActionResult {
  const job = world.jobs[jobId];
  if (!job) return { ok: false, reason: "Job not found." };
  const acceptingShip = job.acceptedBy ? world.traders[job.acceptedBy] : null;
  const penalty = acceptingShip && job.penalty > 0 ? job.penalty : 0;
  if (acceptingShip && world.player && penalty > 0) {
    world.player.funds -= penalty;
  }
  if (acceptingShip) pushJobAbandoned(world, acceptingShip, job, penalty);
  delete world.jobs[job.id];
  return { ok: true };
}

// --- completion ------------------------------------------------------------

export interface JobCompletionEvent {
  jobId: JobId;
  tier: JobTier;
  reward: number;
  partial: boolean;
  delivered: number;
}

// Called after a player ship sells (or otherwise delivers) goods to a market.
// Credits the delivered qty against any active jobs that match (good × destination)
// and pays out the reward + closes the job when fully satisfied.
export function creditJobOnDelivery(
  world: World,
  traderId: TraderId,
  location: LocationId,
  good: GoodId,
  qty: number,
): JobCompletionEvent[] {
  if (!isPlayerShip(world, traderId) || qty <= 0) return [];
  const events: JobCompletionEvent[] = [];
  let remaining = qty;

  // Sort accepted-by-this-trader jobs at this location/good by tier (high
  // first) so big urgent jobs get credited before small idle ones.
  const tierOrder: Record<JobTier, number> = { high: 0, medium: 1, low: 2 };
  const matching = Object.values(world.jobs)
    .filter(j => j.acceptedBy === traderId && j.destination === location && j.good === good)
    .sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

  const ship = world.traders[traderId];
  for (const job of matching) {
    if (remaining <= 0) break;
    const need = job.qty - job.delivered;
    if (need <= 0) continue;
    const credit = Math.min(remaining, need);
    job.delivered += credit;
    remaining -= credit;
    if (job.delivered >= job.qty) {
      if (world.player) world.player.funds += job.reward;
      const ev = { jobId: job.id, tier: job.tier, reward: job.reward, partial: false, delivered: job.delivered };
      if (ship) pushJobCompleted(world, ship, ev, job);
      events.push(ev);
      delete world.jobs[job.id];
    } else {
      events.push({ jobId: job.id, tier: job.tier, reward: 0, partial: true, delivered: job.delivered });
    }
  }
  return events;
}

// --- queries ---------------------------------------------------------------

export function listAvailableJobs(world: World): Job[] {
  return Object.values(world.jobs).filter(j => j.acceptedBy == null);
}

// Shortage jobs are location-gated — you only know a station needs something
// when you're physically there. Rescue jobs broadcast over comms and are
// visible from anywhere.
export function listVisibleAvailableJobs(world: World, location: LocationId | null): Job[] {
  return Object.values(world.jobs).filter(j => {
    if (j.acceptedBy != null) return false;
    if (j.kind === "rescue") return true;
    return location != null && j.destination === location;
  });
}

// Just the unaccepted shortage jobs at a specific station — used by the bridge
// "Local Contracts" callout above the market.
export function listLocalShortageJobs(world: World, location: LocationId): Job[] {
  return Object.values(world.jobs).filter(
    j => j.acceptedBy == null && j.kind === "shortage" && j.destination === location,
  );
}

// All unaccepted jobs (shortage AND rescue) whose destination is this station.
// A rescue is included when a stuck NPC happens to be at the same station the
// player is docked at — the player can resolve it right now by selling fuel,
// no travel needed. Rescues at OTHER stations stay broadcast-only.
export function listLocalJobs(world: World, location: LocationId): Job[] {
  return Object.values(world.jobs).filter(
    j => j.acceptedBy == null && j.destination === location,
  );
}

export function listAvailableRescueJobs(world: World): Job[] {
  return Object.values(world.jobs).filter(j => j.acceptedBy == null && j.kind === "rescue");
}

export function listAcceptedJobs(world: World): Job[] {
  if (!world.player) return [];
  const ships = new Set(world.player.shipIds);
  return Object.values(world.jobs).filter(j => j.acceptedBy != null && ships.has(j.acceptedBy));
}

export function jobsForShipAtLocation(
  world: World,
  trader: Trader,
  location: LocationId,
): Job[] {
  return Object.values(world.jobs).filter(
    j => j.acceptedBy === trader.id && j.destination === location,
  );
}

