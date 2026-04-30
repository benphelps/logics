import type { World } from "../types";
import type { ActiveNewsEvent, NewsEventTemplate, NewsEventsState } from "./types";
import { decayBias, maybeSpawnEvent } from "./spawn";
import { invalidateEventCache } from "./modifier";

export function createNewsEventsState(): NewsEventsState {
  return { enabled: true, active: [], recent: [], bias: {}, nextEventId: 1 };
}

export interface NewsTickReport {
  spawned: ActiveNewsEvent[];
  expired: ActiveNewsEvent[];
}

export function tickNewsEvents(world: World, pool: NewsEventTemplate[]): NewsTickReport {
  // Always invalidate at tick boundary so the per-tick cache doesn't leak.
  invalidateEventCache(world);

  const state = world.newsEvents;
  const spawned: ActiveNewsEvent[] = [];
  const expired: ActiveNewsEvent[] = [];
  if (!state) return { spawned, expired };

  // 1) Expire — move past-expiry events into recent (capped).
  if (state.active.length > 0) {
    const stillActive: ActiveNewsEvent[] = [];
    for (const ev of state.active) {
      if (ev.expiresAt <= world.tick) {
        expired.push(ev);
        state.recent.push({
          uid: ev.uid,
          templateId: ev.templateId,
          tick: world.tick,
          effects: ev.effects,
        });
      } else {
        stillActive.push(ev);
      }
    }
    state.active = stillActive;
    if (state.recent.length > 64) {
      state.recent.splice(0, state.recent.length - 64);
    }
  }

  // 2) Bias decay — runs every tick so long-run drift trends to zero.
  decayBias(state);

  // 3) Spawn — cadence-gated inside maybeSpawnEvent.
  if (state.enabled) {
    const ev = maybeSpawnEvent(world, pool);
    if (ev) spawned.push(ev);
  }

  // Active set changed → drop any cached multipliers from earlier in the same
  // tick (e.g. a price hook that ran before tickNewsEvents wouldn't, but if
  // anything else queries within this tick it must see the updated active list).
  if (spawned.length > 0 || expired.length > 0) {
    invalidateEventCache(world);
  }

  return { spawned, expired };
}
