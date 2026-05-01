import type { EquityId, GoodId, Job, JobId, JobTier, LocationId, TradeAction, Trader, TraderId, World } from "./types";
import { pushJobAbandoned, pushJobAccepted, pushJobCompleted, pushJobExpired } from "./log";
import { contractRewardFraction } from "./crew";
import { eventMultiplier } from "./news/modifier";
import { incrementManualActions } from "./milestones";

// Fold the trader's contractRewardBonus modifier into the base reward, then
// apply any active news-event multiplier on contract rewards (per-destination).
// Floors at 0 so a malformed modifier can't pay the player to leave.
function rewardWithBonus(world: World, ship: Trader, job: Job): number {
  if (job.reward <= 0) return 0;
  const bonus = contractRewardFraction(ship);
  const mult = eventMultiplier(world, "contract_reward", {
    locationId: job.destination,
    goodId: job.good,
  });
  return Math.max(0, job.reward * (1 + bonus) * mult);
}

// --- tunables --------------------------------------------------------------

export const MAX_OPEN_JOBS = 24;            // minimum board size for small worlds
export const OPEN_JOBS_PER_LOCATION = 1.5;  // board size scales with universe size
export const RESCUE_JOB_RESERVE_FRACTION = 0.20;

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
export const TRADE_JOB_EXPIRY_TICKS = 90;
export const EXCHANGE_LOSS_FORGIVENESS_RATE = 0.20;
export const EXCHANGE_LOSS_FORGIVENESS_MAX = 5_000;

// Quantity = SHORTAGE_QTY_FRACTION * (target - currentStock), capped at SHORTAGE_QTY_MAX
export const SHORTAGE_QTY_FRACTION = 0.5;
export const SHORTAGE_QTY_MAX = 80;
export const SHORTAGE_QTY_MIN = 5;

// Rescue: deliver qty fuel = RESCUE_FUEL_FRACTION * trader.fuelCapacity
export const RESCUE_FUEL_FRACTION = 0.5;

// --- helpers ---------------------------------------------------------------

export function maxOpenJobs(world: World): number {
  const stationCount = Object.keys(world.locations).length;
  return Math.max(MAX_OPEN_JOBS, Math.ceil(stationCount * OPEN_JOBS_PER_LOCATION));
}

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
  for (const j of Object.values(world.jobs)) set.add(`${j.kind}|${j.destination}|${j.good ?? j.id}`);
  return set;
}

function isPlayerShip(world: World, traderId: TraderId | null | undefined): boolean {
  if (!traderId || !world.player) return false;
  return world.player.shipIds.includes(traderId);
}

type ShortageCandidate = {
  kind: "shortage";
  location: LocationId;
  good: GoodId;
  tier: JobTier;
  qty: number;
  reward: number;
  penalty: number;
  severity: number;
};

type RescueCandidate = {
  kind: "rescue";
  location: LocationId;
  good: GoodId;
  tier: JobTier;
  qty: number;
  reward: number;
  penalty: number;
  rescueTarget: TraderId;
  stuckTicks: number;
};

const tierOrder: Record<JobTier, number> = { high: 0, medium: 1, low: 2 };

function sortShortageCandidates(candidates: ShortageCandidate[]): ShortageCandidate[] {
  const byLocation = new Map<LocationId, ShortageCandidate[]>();
  for (const candidate of candidates) {
    const bucket = byLocation.get(candidate.location) ?? [];
    bucket.push(candidate);
    byLocation.set(candidate.location, bucket);
  }

  for (const bucket of byLocation.values()) {
    bucket.sort((a, b) =>
      tierOrder[a.tier] - tierOrder[b.tier]
      || a.severity - b.severity
      || a.good.localeCompare(b.good),
    );
  }

  const locations = [...byLocation.entries()].sort((a, b) => {
    const bestA = a[1][0];
    const bestB = b[1][0];
    return tierOrder[bestA.tier] - tierOrder[bestB.tier]
      || bestA.severity - bestB.severity
      || a[0].localeCompare(b[0]);
  });

  const sorted: ShortageCandidate[] = [];
  let added = true;
  while (added) {
    added = false;
    for (const [, bucket] of locations) {
      const next = bucket.shift();
      if (!next) continue;
      sorted.push(next);
      added = true;
    }
  }
  return sorted;
}

function sortRescueCandidates(candidates: RescueCandidate[]): RescueCandidate[] {
  return [...candidates].sort((a, b) =>
    tierOrder[a.tier] - tierOrder[b.tier]
    || b.stuckTicks - a.stuckTicks
    || a.location.localeCompare(b.location),
  );
}

function tierForTradeReward(reward: number): JobTier {
  if (reward >= 5_000) return "high";
  if (reward >= 1_000) return "medium";
  return "low";
}

export function exchangeLossForgiveness(loss: number): number {
  if (loss <= 0) return 0;
  return Math.round(Math.min(loss * EXCHANGE_LOSS_FORGIVENESS_RATE, EXCHANGE_LOSS_FORGIVENESS_MAX));
}

export function createTradeJob(world: World, opts: {
  traderId: TraderId;
  destination: LocationId;
  equityId: EquityId;
  ticker: string;
  action: Extract<TradeAction, "close_long" | "cover_short">;
  shares: number;
  realizedPnl: number;
  reward: number;
  settlementKind: "profit" | "loss_forgiveness";
}): Job | null {
  const reward = Math.round(opts.reward);
  if (reward <= 0 || !world.locations[opts.destination]) return null;
  const ship = world.traders[opts.traderId];
  if (!ship || !isPlayerShip(world, opts.traderId)) return null;
  const job: Job = {
    id: makeJobId(world),
    kind: "trade",
    tier: tierForTradeReward(reward),
    qty: opts.shares,
    destination: opts.destination,
    reward,
    penalty: 0,
    postedTick: world.tick,
    expiresAt: world.tick + TRADE_JOB_EXPIRY_TICKS,
    acceptedBy: opts.traderId,
    delivered: 0,
    trade: {
      equityId: opts.equityId,
      ticker: opts.ticker,
      action: opts.action,
      shares: opts.shares,
      realizedPnl: opts.realizedPnl,
      settlementKind: opts.settlementKind,
    },
  };
  world.jobs[job.id] = job;
  pushJobAccepted(world, ship, job);
  return job;
}

// --- generation ------------------------------------------------------------

export function generateJobs(world: World): Job[] {
  const openCount = Object.keys(world.jobs).length;
  const cap = maxOpenJobs(world);
  if (openCount >= cap) return [];
  const posted: Job[] = [];
  const index = buildJobIndex(world);
  const totalOpen = () => openCount + posted.length;

  const shortageCandidates: ShortageCandidate[] = [];
  const rescueCandidates: RescueCandidate[] = [];

  // 1) Shortages — scan markets for stock far below target on consumed goods.
  for (const loc of Object.values(world.locations)) {
    const market = world.markets[loc.id];
    for (const consumed of loc.consumes) {
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
      shortageCandidates.push({
        kind: "shortage",
        location: loc.id,
        good: consumed.good,
        tier,
        qty,
        reward,
        penalty,
        severity: stock / target,
      });
    }
  }

  const rescueIndex = new Set(index);
  for (const trader of Object.values(world.traders)) {
    if (isPlayerShip(world, trader.id)) continue;
    if ((trader.stuckTicks ?? 0) <= 0) continue;
    if (trader.fuelTypes.length === 0) continue;
    const fuelGood = trader.fuelTypes[0].good;
    const key = `rescue|${trader.location}|${fuelGood}`;
    if (rescueIndex.has(key)) continue;

    const tier = tierForRescue(trader.stuckTicks ?? 0);
    const qty = Math.max(SHORTAGE_QTY_MIN, Math.floor(trader.fuelCapacity * RESCUE_FUEL_FRACTION));
    const fuel = world.goods[fuelGood];
    if (!fuel) continue;
    const reward = Math.round(qty * fuel.basePrice * REWARD_MULT_BY_TIER[tier]);
    const penalty = Math.round(reward * PENALTY_FRACTION_BY_TIER[tier]);
    rescueCandidates.push({
      kind: "rescue",
      location: trader.location,
      good: fuelGood,
      tier,
      qty,
      reward,
      penalty,
      rescueTarget: trader.id,
      stuckTicks: trader.stuckTicks ?? 0,
    });
    rescueIndex.add(key);
  }

  const slots = cap - openCount;
  const rescueReserve = Math.min(
    rescueCandidates.length,
    Math.ceil(cap * RESCUE_JOB_RESERVE_FRACTION),
  );
  const shortagePrimarySlots = Math.max(0, slots - rescueReserve);
  const sortedShortages = sortShortageCandidates(shortageCandidates);
  const sortedRescues = sortRescueCandidates(rescueCandidates);

  const postShortage = (candidate: ShortageCandidate): void => {
    const job: Job = {
      id: makeJobId(world),
      kind: "shortage",
      tier: candidate.tier,
      good: candidate.good,
      qty: candidate.qty,
      destination: candidate.location,
      reward: candidate.reward,
      penalty: candidate.penalty,
      postedTick: world.tick,
      expiresAt: world.tick + EXPIRY_TICKS_BY_TIER[candidate.tier],
      acceptedBy: null,
      delivered: 0,
    };
    world.jobs[job.id] = job;
    index.add(`shortage|${candidate.location}|${candidate.good}`);
    posted.push(job);
  };

  const postRescue = (candidate: RescueCandidate): void => {
    const job: Job = {
      id: makeJobId(world),
      kind: "rescue",
      tier: candidate.tier,
      good: candidate.good,
      qty: candidate.qty,
      destination: candidate.location,
      reward: candidate.reward,
      penalty: candidate.penalty,
      postedTick: world.tick,
      expiresAt: world.tick + EXPIRY_TICKS_BY_TIER[candidate.tier],
      acceptedBy: null,
      delivered: 0,
      rescueTarget: candidate.rescueTarget,
    };
    world.jobs[job.id] = job;
    index.add(`rescue|${candidate.location}|${candidate.good}`);
    posted.push(job);
  };

  for (const candidate of sortedShortages.splice(0, shortagePrimarySlots)) {
    if (totalOpen() >= cap) break;
    postShortage(candidate);
  }

  for (const candidate of sortedRescues) {
    if (totalOpen() >= cap) break;
    postRescue(candidate);
  }

  for (const candidate of sortedShortages) {
    if (totalOpen() >= cap) break;
    postShortage(candidate);
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

// Remove jobs past their deadline. If the job was accepted, charge the
// penalty against the accepting ship's wallet — high-tier jobs really hurt.
export function expireJobs(world: World): JobExpiryEvent[] {
  const events: JobExpiryEvent[] = [];
  for (const job of Object.values(world.jobs)) {
    if (world.tick < job.expiresAt) continue;
    const acceptingShip = job.acceptedBy ? world.traders[job.acceptedBy] : null;
    const penalty = acceptingShip ? job.penalty : 0;
    if (acceptingShip && job.penalty > 0) {
      acceptingShip.funds = Math.max(0, acceptingShip.funds - job.penalty);
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
  if (job.kind === "trade") return { ok: false, reason: "Trade settlements are assigned automatically." };
  if (job.acceptedBy != null) return { ok: false, reason: "Job already accepted." };
  const ship = world.traders[traderId];
  if (!ship) return { ok: false, reason: "Unknown ship." };
  if (!isPlayerShip(world, traderId)) return { ok: false, reason: "Only player ships can accept jobs." };
  job.acceptedBy = traderId;
  pushJobAccepted(world, ship, job);
  incrementManualActions(world);
  return { ok: true };
}

export function collectTradeJob(world: World, jobId: JobId, traderId: TraderId): JobActionResult {
  const job = world.jobs[jobId];
  if (!job) return { ok: false, reason: "Settlement no longer available." };
  if (job.kind !== "trade") return { ok: false, reason: "That job is not an exchange settlement." };
  const ship = world.traders[traderId];
  if (!ship) return { ok: false, reason: "Unknown ship." };
  if (!isPlayerShip(world, traderId)) return { ok: false, reason: "Only player ships can collect exchange settlements." };
  if (job.acceptedBy !== traderId) return { ok: false, reason: "Settlement is assigned to another ship." };
  if (ship.state !== "idle") return { ok: false, reason: "Dock before collecting the settlement." };
  if (ship.location !== job.destination) {
    const dst = world.locations[job.destination]?.name ?? job.destination;
    return { ok: false, reason: `Collect this settlement at ${dst}.` };
  }
  const reward = rewardWithBonus(world, ship, job);
  ship.funds += reward;
  pushJobCompleted(world, ship, { reward, partial: false }, job);
  delete world.jobs[job.id];
  incrementManualActions(world);
  return { ok: true };
}

// Abandoning an accepted job charges the failure penalty (same as expiry).
// For an unaccepted job (clearing it from the board), just remove it freely.
export function abandonJob(world: World, jobId: JobId): JobActionResult {
  const job = world.jobs[jobId];
  if (!job) return { ok: false, reason: "Job not found." };
  const acceptingShip = job.acceptedBy ? world.traders[job.acceptedBy] : null;
  const penalty = acceptingShip && job.penalty > 0 ? job.penalty : 0;
  if (acceptingShip && penalty > 0) {
    acceptingShip.funds = Math.max(0, acceptingShip.funds - penalty);
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
    .filter(j => j.kind !== "trade" && j.good === good && j.acceptedBy === traderId && j.destination === location)
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
      const reward = ship ? rewardWithBonus(world, ship, job) : job.reward;
      if (ship) ship.funds += reward;
      const ev = { jobId: job.id, tier: job.tier, reward, partial: false, delivered: job.delivered };
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
