import type { Job } from "./types";
import type { ShipLogEntry, ShipLogTone, Trader, World } from "./types";
import type { TraderEvent } from "./traders";

export const SHIP_LOG_MAX = 60;

export function pushShipLog(ship: Trader, entry: ShipLogEntry | null): void {
  if (!entry) return;
  // Lazily initialize so traders constructed inline by tests (or via older
  // serialized state) don't crash. Production fixtures all default to [].
  if (!ship.log) ship.log = [];
  ship.log.push(entry);
  // Drop the oldest entries once the cap is exceeded — bounded memory across
  // long sessions. We splice in place rather than reassigning so persisted
  // references (UI snapshots) stay valid.
  if (ship.log.length > SHIP_LOG_MAX) {
    ship.log.splice(0, ship.log.length - SHIP_LOG_MAX);
  }
}

// Convert a TraderEvent into a human-readable log entry. Returns null for
// noisy "idle" events — those would flood the log without saying much.
export function formatTraderEvent(world: World, ev: TraderEvent): ShipLogEntry | null {
  const tick = world.tick;
  const goodName = (id?: string) => (id ? world.goods[id]?.name ?? id : "");
  const locName = (id?: string) => (id ? world.locations[id]?.name ?? id : "");
  switch (ev.kind) {
    case "buy":
      return {
        tick, kind: "buy",
        message: `Bought ${ev.qty?.toFixed(0)} ${goodName(ev.good)} @ Ç${ev.unitPrice?.toFixed(1)} at ${locName(ev.from)}`,
      };
    case "sell":
      return {
        tick, kind: "sell", tone: "good",
        message: `Sold ${ev.qty?.toFixed(0)} ${goodName(ev.good)} @ Ç${ev.unitPrice?.toFixed(1)} at ${locName(ev.to)}`,
      };
    case "depart":
      return { tick, kind: "depart", message: `Departed ${locName(ev.from)} → ${locName(ev.to)}` };
    case "arrive":
      return { tick, kind: "arrive", message: `Arrived at ${locName(ev.to)}` };
    case "refuel":
      return {
        tick, kind: "refuel",
        message: `Refueled ${ev.qty?.toFixed(0)} ${goodName(ev.good)} @ Ç${ev.unitPrice?.toFixed(1)}`,
      };
    case "stuck":
      return { tick, kind: "stuck", tone: "bad", message: "Stranded — out of fuel and no reachable hop." };
    case "idle":
      return null;
  }
  return null;
}

export function pushTraderEvent(world: World, ship: Trader, ev: TraderEvent): void {
  pushShipLog(ship, formatTraderEvent(world, ev));
}

// --- job-flavored entries -------------------------------------------------

function jobBlurb(world: World, job: Job): string {
  if (job.kind === "trade") {
    const dst = world.locations[job.destination]?.name ?? job.destination;
    const ticker = job.trade?.ticker ?? "trade";
    const kind = job.trade?.settlementKind === "loss_forgiveness" ? "Loss review" : "Profit settlement";
    return `${kind}: ${ticker} at ${dst}`;
  }
  const goodName = job.good ? world.goods[job.good]?.name ?? job.good : "Unknown";
  const dst = world.locations[job.destination]?.name ?? job.destination;
  return `${job.kind === "rescue" ? "Rescue" : "Contract"}: ${job.qty} ${goodName} → ${dst}`;
}

export function pushJobAccepted(world: World, ship: Trader, job: Job): void {
  pushShipLog(ship, {
    tick: world.tick,
    kind: "job_accepted",
    tone: "info",
    message: job.kind === "trade"
      ? `Settlement posted for ${jobBlurb(world, job)} (Ç${job.reward.toLocaleString()} pending)`
      : `Accepted ${job.tier}-tier ${jobBlurb(world, job)} (Ç${job.reward.toLocaleString()} reward)`,
  });
}

export function pushJobCompleted(
  world: World,
  ship: Trader,
  ev: { reward: number; partial: boolean },
  job: Job | null,
): void {
  if (ev.partial) return; // partial deliveries are noisy and the per-tick "Sold X" entry covers it
  pushShipLog(ship, {
    tick: world.tick,
    kind: "job_completed",
    tone: "good",
    message: job
      ? `Completed ${jobBlurb(world, job)} — Ç${ev.reward.toLocaleString()} paid out`
      : `Contract complete — Ç${ev.reward.toLocaleString()} paid out`,
  });
}

export function pushJobExpired(world: World, ship: Trader, job: Job, penalty: number): void {
  pushShipLog(ship, {
    tick: world.tick,
    kind: "job_expired",
    tone: penalty > 0 ? "bad" : "warn",
    message: penalty > 0
      ? `Failed ${jobBlurb(world, job)} — Ç${penalty.toLocaleString()} penalty`
      : `Expired ${jobBlurb(world, job)} (no penalty)`,
  });
}

export function pushJobAbandoned(world: World, ship: Trader, job: Job, penalty: number): void {
  pushShipLog(ship, {
    tick: world.tick,
    kind: "job_abandoned",
    tone: penalty > 0 ? "bad" : "warn",
    message: penalty > 0
      ? `Abandoned ${jobBlurb(world, job)} — Ç${penalty.toLocaleString()} penalty`
      : `Abandoned ${jobBlurb(world, job)}`,
  });
}

// Used by callers that already have a fully-formatted entry (e.g. a tick-level
// summary). Kept tone-narrow so callers can't pollute with arbitrary kinds.
export function pushNote(world: World, ship: Trader, message: string, tone?: ShipLogTone): void {
  pushShipLog(ship, { tick: world.tick, kind: "note", message, tone });
}
