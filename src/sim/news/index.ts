export type {
  ActiveNewsEvent,
  NewsCtx,
  NewsEffect,
  NewsEventTemplate,
  NewsEventsState,
  NewsScope,
  NewsTarget,
  NewsTargetKind,
  NewsTone,
  RecentNewsEvent,
} from "./types";

export { eventMultiplier, invalidateEventCache } from "./modifier";
export { createNewsEventsState, tickNewsEvents } from "./tick";
export type { NewsTickReport } from "./tick";
export {
  applyResolvedNewsEvent,
  MAX_ACTIVE_EVENTS,
  MAX_INFLIGHT_REQUESTS,
  NEWS_SPAWN_CHANCE,
  NEWS_SPAWN_PERIOD,
  maybeQueueNewsRequest,
} from "./spawn";
export type { NewsBiasHint, NewsSpawnRequest, ResolvedNewsEvent } from "./spawn";
