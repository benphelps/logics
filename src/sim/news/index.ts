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
export { getNewsPool, loadNewsPool, setNewsPoolForTests } from "./pool";
export {
  MAX_ACTIVE_EVENTS,
  NEWS_SPAWN_CHANCE,
  NEWS_SPAWN_PERIOD,
  maybeSpawnEvent,
} from "./spawn";
