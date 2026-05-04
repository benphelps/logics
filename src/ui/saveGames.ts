import type { CrewMember, Hire, World } from "../sim/types";
import { ensureStockMarket } from "../sim/stock";
import { warmUpBook } from "../sim/stock/agents";
import { createGameId } from "../sim/world";
import { deriveCrewIdentity } from "../sim/crewIdentity";
import { createNewsEventsState } from "../sim/news/tick";
import type { ActiveNewsEvent, NewsTarget, RecentNewsEvent } from "../sim/news/types";
import { deleteGame as deleteGameHistory, flushHistoryFromWorld } from "./historyDb";
import { normalizePanelScrollPositions, normalizeViewTabs, type PanelScrollPositions, type ViewTabs } from "./viewTabs";

const SAVE_REGISTRY_KEY = "logics.saveGames.v1";
const SAVE_VERSION = 1;

export type SaveGameKind = "standard" | "developer";
export type SaveStatus = "saved" | "unavailable" | "error";

interface SaveWriteResult {
  status: SaveStatus;
  error: string | null;
}

export interface SaveSlotSummary {
  id: string;
  name: string;
  kind: SaveGameKind;
  tick: number;
  createdAt: number;
  updatedAt: number;
  // Pilot fields surface in the save card without needing to rehydrate
  // the full world. Optional for back-compat with older saves that
  // pre-date the new-game wizard.
  pilotName?: string;
  pilotPortraitId?: string;
}

interface PersistedSaveGame extends SaveSlotSummary {
  version: typeof SAVE_VERSION;
  world: World;
  // Optional so older saves load cleanly — the store falls back to
  // defaults when missing.
  viewTabs?: ViewTabs;
  panelScrollPositions?: PanelScrollPositions;
}

interface SaveRegistry {
  version: typeof SAVE_VERSION;
  activeId: string | null;
  saves: PersistedSaveGame[];
}

export interface LoadedGameSession {
  world: World;
  activeSaveId: string | null;
  gameName: string;
  gameKind: SaveGameKind;
  saveSlots: SaveSlotSummary[];
  saveStatus: SaveStatus;
  saveError: string | null;
  viewTabs?: ViewTabs;
  panelScrollPositions?: PanelScrollPositions;
  // True when this load could not find any existing save and we
  // synthesized one from scratch — used by the store to auto-open
  // the new-game picker so the player still gets to choose their
  // syndicate on the very first launch.
  isFreshStart?: boolean;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isSaveKind(value: unknown): value is SaveGameKind {
  return value === "standard" || value === "developer";
}

function isPersistedSave(value: unknown): value is PersistedSaveGame {
  if (!isRecord(value)) return false;
  return value.version === SAVE_VERSION
    && typeof value.id === "string"
    && typeof value.name === "string"
    && isSaveKind(value.kind)
    && typeof value.tick === "number"
    && typeof value.createdAt === "number"
    && typeof value.updatedAt === "number"
    && isRecord(value.world);
}

function cloneWorld(world: World): World {
  if (typeof structuredClone === "function") return structuredClone(world) as World;
  return JSON.parse(JSON.stringify(world)) as World;
}

// Compact a world before serializing to localStorage. The save snapshot is
// a "current state only" view — historical streams live in IndexedDB:
//   - equity.history / equity.recentTrades / trader.log are stripped entirely
//     (see historyDb.ts), partitioned by world.gameId.
//   - Order book TTL entries are agent quotes that re-post in a few ticks;
//     player limit orders (no TTL) survive untouched.
//
// We deliberately DON'T structuredClone the full world here. Those three
// stripped streams grow unbounded with playtime — at 3000+ ticks across
// 80 equities the rings are hundreds of thousands of entries. Cloning them
// just to overwrite with [] was the dominant per-autosave cost (visible as
// a once-per-2s hitch at 16x). Instead we shallow-copy each entity record
// with the heavy fields swapped for empty arrays / TTL-filtered books, and
// share references for everything bounded. JSON.stringify (the next step)
// is synchronous, so no concurrent tick can mutate the live references
// while serialization runs.
function compactWorldForSave(world: World): World {
  const equities: World["equities"] = {};
  for (const [id, eq] of Object.entries(world.equities ?? {})) {
    equities[id] = { ...eq, history: [], recentTrades: [] };
  }
  const traders: World["traders"] = {};
  for (const [id, t] of Object.entries(world.traders)) {
    // log + stockTrades both live in IndexedDB; strip from the save
    // snapshot so we don't write the same data to both stores.
    traders[id] = { ...t, log: [], stockTrades: [] };
  }
  let orderBooks = world.orderBooks;
  if (orderBooks) {
    const next: NonNullable<World["orderBooks"]> = {};
    for (const [id, book] of Object.entries(orderBooks)) {
      next[id] = {
        ...book,
        bids: book.bids.filter(o => o.ttl == null),
        asks: book.asks.filter(o => o.ttl == null),
      };
    }
    orderBooks = next;
  }
  // Legacy player.trades shares its array reference with ship.stockTrades
  // (see migratePlayerStockToShips). The trader strip above replaces
  // stockTrades on the cloned trader, but player.trades on the live
  // world still points at the original full array. Mirror the strip on
  // the player so the snapshot is consistent.
  const player = world.player ? { ...world.player, trades: [] } : world.player;
  return { ...world, equities, traders, orderBooks, player };
}


// Saves predating later mechanics (treasuries, stock market, long/short
// positions) won't have those fields. Backfill on load so the rest of the
// sim doesn't blow up on `Object.keys(undefined)`. Treasuries get
// initialized lazily inside `tickTreasuries`, so just the stock market
// + portfolio shape need explicit backfill.
function migrateLoadedWorld(world: World): World {
  if (!world.gameId) world.gameId = createGameId();
  if (!world.equities) world.equities = {};
  if (!world.syndicates) world.syndicates = {};
  ensureStockMarket(world);
  backfillCrewIdentity(world);
  backfillNewsEvents(world);
  // After loading a compacted save (orderBooks have player orders only),
  // give every equity at least one round of agent quotes so the player
  // can trade immediately. Idempotent — agents post at most one bid +
  // one ask per equity. Player limit orders (no TTL) survive untouched.
  warmUpBook(world);
  if (world.player) {
    if (!world.player.positions) world.player.positions = {};
    if (!world.player.trades) world.player.trades = [];
    // Pre-position-model saves used `portfolio: { eqId: shares }` for
    // long-only holdings. Migrate any leftover entries into the new
    // positions record using the current equity price as a stand-in entry
    // price (we don't know the historical fill).
    if (world.player.portfolio) {
      for (const [eqId, shares] of Object.entries(world.player.portfolio)) {
        if (typeof shares !== "number" || shares <= 0) continue;
        if (world.player.positions[eqId]) continue;       // already has a real position
        const eq = world.equities[eqId];
        if (!eq) continue;
        world.player.positions[eqId] = {
          equityId: eqId,
          kind: "long",
          shares,
          avgEntryPrice: eq.price,
          openedAt: world.tick,
        };
      }
      world.player.portfolio = {};
    }
    // Multi-ship migration: pre-multi-ship saves stored stock positions /
    // trades / futures / reserved-* on the player. Each ship now owns its
    // own copy. Promote the legacy player-wide state onto the first ship
    // so trades and positions stick to the original ship the player was
    // controlling. New ships start empty.
    migratePlayerStockToShips(world);
  }
  return world;
}

function migratePlayerStockToShips(world: World): void {
  const player = world.player;
  if (!player) return;
  const firstShipId = player.shipIds[0];
  const firstShip = firstShipId ? world.traders[firstShipId] : null;
  if (!firstShip) return;

  if (player.positions && Object.keys(player.positions).length > 0 && !firstShip.stockPositions) {
    firstShip.stockPositions = { ...player.positions };
  }
  if (player.trades && player.trades.length > 0 && !firstShip.stockTrades) {
    firstShip.stockTrades = [...player.trades];
  }
  if (player.reservedShares && Object.keys(player.reservedShares).length > 0 && !firstShip.reservedShares) {
    firstShip.reservedShares = { ...player.reservedShares };
  }
  if (player.futures && Object.keys(player.futures).length > 0 && !firstShip.futures) {
    firstShip.futures = { ...player.futures };
  }
  if (player.reservedFutures && Object.keys(player.reservedFutures).length > 0 && !firstShip.reservedFutures) {
    firstShip.reservedFutures = { ...player.reservedFutures };
  }
}

// Pre-news saves won't have a newsEvents field. Backfill a fresh state so
// the sim never crashes on Object.keys(undefined). Also prune any active or
// recent events whose targets no longer exist (covers dev scenarios where
// stations or syndicates were edited between save and load).
function backfillNewsEvents(world: World): void {
  if (!world.newsEvents) {
    world.newsEvents = createNewsEventsState();
    return;
  }
  const state = world.newsEvents;
  state.enabled = state.enabled ?? true;
  state.active = Array.isArray(state.active) ? state.active.filter(ev => allTargetsValid(world, ev)) : [];
  state.recent = Array.isArray(state.recent) ? state.recent.filter(ev => allTargetsValid(world, ev)) : [];
  state.bias = state.bias && typeof state.bias === "object" ? state.bias : {};
  state.nextEventId = typeof state.nextEventId === "number" && state.nextEventId > 0 ? state.nextEventId : 1;
}

function allTargetsValid(world: World, ev: ActiveNewsEvent | RecentNewsEvent): boolean {
  for (const eff of ev.effects) {
    if (!targetIsValid(world, eff.target)) return false;
  }
  return true;
}

function targetIsValid(world: World, target: NewsTarget): boolean {
  if (target.kind === "global") return true;
  if (!target.id) return true; // category-only targets don't depend on a specific id
  switch (target.kind) {
    case "good":      return world.goods[target.id] != null;
    case "location":  return world.locations[target.id] != null;
    case "syndicate": return world.syndicates[target.id] != null;
    case "index":     return world.equities[target.id] != null;
    default:          return false;
  }
}

// Pre-identity saves don't have sex/age/race on crew or hires. Derive the
// values from the stable id so portrait lookups produce a consistent face
// for crew the player already knows by name.
function backfillCrewIdentity(world: World): void {
  const fillCrew = (member: CrewMember): void => {
    if (member.sex && member.age && member.race) return;
    const id = member.sex ?? member.age ?? member.race ? `${member.id}-fill` : member.id;
    const identity = deriveCrewIdentity(id);
    if (!member.sex)  member.sex = identity.sex;
    if (!member.age)  member.age = identity.age;
    if (!member.race) member.race = identity.race;
  };
  const fillHire = (hire: Hire): void => {
    if (hire.sex && hire.age && hire.race) return;
    const identity = deriveCrewIdentity(hire.id);
    if (!hire.sex)  hire.sex = identity.sex;
    if (!hire.age)  hire.age = identity.age;
    if (!hire.race) hire.race = identity.race;
  };
  for (const trader of Object.values(world.traders)) {
    if (!trader.crew) continue;
    for (const member of Object.values(trader.crew)) {
      if (member) fillCrew(member);
    }
  }
  if (world.hires) {
    for (const hire of Object.values(world.hires)) fillHire(hire);
  }
}

// Cached registry across calls. The localStorage layout puts every save slot
// (each holding a full World) under a single key — re-reading it on every
// autosave means JSON.parse-ing megabytes every 2s, which shows up in
// profiles as the "every-2s freeze". We're the only writer, so the cache is
// always authoritative; just keep it warm and skip the parse.
let cachedRegistry: SaveRegistry | null | undefined; // undefined = not yet loaded

function readRegistry(): SaveRegistry | null {
  if (cachedRegistry !== undefined) return cachedRegistry;
  const storage = browserStorage();
  if (!storage) {
    cachedRegistry = null;
    return null;
  }
  try {
    const raw = storage.getItem(SAVE_REGISTRY_KEY);
    if (!raw) {
      cachedRegistry = { version: SAVE_VERSION, activeId: null, saves: [] };
      return cachedRegistry;
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== SAVE_VERSION || !Array.isArray(parsed.saves)) {
      cachedRegistry = null;
      return null;
    }
    const saves = parsed.saves.filter(isPersistedSave);
    const activeId = typeof parsed.activeId === "string" ? parsed.activeId : null;
    cachedRegistry = { version: SAVE_VERSION, activeId, saves };
    return cachedRegistry;
  } catch (error) {
    console.warn("[logics] Save registry read failed", error);
    cachedRegistry = null;
    return null;
  }
}

function describeSaveError(error: unknown, registry: SaveRegistry, payloadChars: number): string {
  const errorName = error instanceof Error ? error.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  const sizeMb = (payloadChars / (1024 * 1024)).toFixed(2);
  return `${errorName}: ${message} while writing ${registry.saves.length} save slot${registry.saves.length === 1 ? "" : "s"} (${sizeMb} MB JSON).`;
}

function writeRegistry(registry: SaveRegistry): SaveWriteResult {
  // Always update the cache so subsequent readRegistry() calls don't have
  // to round-trip through localStorage again.
  cachedRegistry = registry;
  const storage = browserStorage();
  if (!storage) return { status: "unavailable", error: "Browser localStorage is unavailable." };
  let payload: string;
  try {
    payload = JSON.stringify(registry);
  } catch (error) {
    const detail = `Could not serialize save registry: ${error instanceof Error ? error.message : String(error)}.`;
    console.warn("[logics] Save serialization failed", { detail, error, slots: registry.saves.length });
    return { status: "error", error: detail };
  }
  try {
    storage.setItem(SAVE_REGISTRY_KEY, payload);
    return { status: "saved", error: null };
  } catch (error) {
    const detail = describeSaveError(error, registry, payload.length);
    console.warn("[logics] Save write failed", {
      detail,
      payloadChars: payload.length,
      slots: registry.saves.length,
      error,
    });
    return { status: "error", error: detail };
  }
}

function summarize(save: PersistedSaveGame): SaveSlotSummary {
  const pilot = save.world.player?.pilot;
  return {
    id: save.id,
    name: save.name,
    kind: save.kind,
    tick: save.world.tick,
    createdAt: save.createdAt,
    updatedAt: save.updatedAt,
    pilotName: pilot?.name,
    pilotPortraitId: pilot?.portraitId,
  };
}

function summaries(registry: SaveRegistry): SaveSlotSummary[] {
  return registry.saves
    .map(summarize)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function createSaveId(prefix = "game"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function nextSaveName(slots: SaveSlotSummary[], base: string): string {
  const names = new Set(slots.map(slot => slot.name));
  if (!names.has(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base} ${i}`;
    if (!names.has(candidate)) return candidate;
  }
  return `${base} ${Date.now().toString(36)}`;
}

function makeSave(
  id: string,
  name: string,
  kind: SaveGameKind,
  world: World,
  createdAt = Date.now(),
  viewTabs?: ViewTabs,
  panelScrollPositions?: PanelScrollPositions,
): PersistedSaveGame {
  const now = Date.now();
  return {
    version: SAVE_VERSION,
    id,
    name,
    kind,
    tick: world.tick,
    createdAt,
    updatedAt: now,
    world: compactWorldForSave(world),
    viewTabs,
    panelScrollPositions: panelScrollPositions ? normalizePanelScrollPositions(panelScrollPositions) : undefined,
  };
}

// `liveWorld`, when provided, overrides the cloned-from-snapshot world. Save
// paths pass the original (still-mutating) world so the store keeps the
// reference it was already using and the in-memory history rings survive
// the save round-trip. Load paths omit it and get a fresh stripped clone
// the caller hydrates from IndexedDB.
function loadedFromSave(
  save: PersistedSaveGame,
  registry: SaveRegistry,
  write: SaveWriteResult,
  liveWorld?: World,
): LoadedGameSession {
  return {
    world: liveWorld ?? migrateLoadedWorld(cloneWorld(save.world)),
    activeSaveId: save.id,
    gameName: save.name,
    gameKind: save.kind,
    saveSlots: summaries(registry),
    saveStatus: write.status,
    saveError: write.error,
    viewTabs: save.viewTabs ? normalizeViewTabs(save.viewTabs) : undefined,
    panelScrollPositions: save.panelScrollPositions ? normalizePanelScrollPositions(save.panelScrollPositions) : undefined,
  };
}

export function loadInitialGame(createFallbackWorld: () => World): LoadedGameSession {
  const registry = readRegistry();
  const fallbackWorld = () => createFallbackWorld();
  if (!registry) {
    return {
      world: fallbackWorld(),
      activeSaveId: null,
      gameName: "Voyager",
      gameKind: "standard",
      saveSlots: [],
      saveStatus: browserStorage() ? "error" : "unavailable",
      saveError: browserStorage() ? "Could not read save registry from localStorage." : "Browser localStorage is unavailable.",
      isFreshStart: true,
    };
  }

  const active = registry.saves.find(save => save.id === registry.activeId) ?? registry.saves[0];
  if (active) return loadedFromSave(active, registry, { status: "saved", error: null });

  const world = fallbackWorld();
  const save = makeSave(createSaveId(), "Voyager", "standard", world);
  const next: SaveRegistry = { version: SAVE_VERSION, activeId: save.id, saves: [save] };
  const write = writeRegistry(next);
  // Fresh world with populated rings — pass live so the caller has chart
  // data immediately without waiting for an IDB hydrate round-trip.
  return { ...loadedFromSave(save, next, write, world), isFreshStart: true };
}

export function saveGameSlot(
  id: string | null,
  name: string,
  kind: SaveGameKind,
  world: World,
  viewTabs?: ViewTabs,
  panelScrollPositions?: PanelScrollPositions,
): LoadedGameSession {
  const registry = readRegistry();
  if (!registry) {
    return {
      world,
      activeSaveId: id,
      gameName: name,
      gameKind: kind,
      saveSlots: [],
      saveStatus: browserStorage() ? "error" : "unavailable",
      saveError: browserStorage() ? "Could not read save registry from localStorage." : "Browser localStorage is unavailable.",
      viewTabs,
      panelScrollPositions,
    };
  }

  // Flush in-memory history rings (Equity.history, Equity.recentTrades,
  // Trader.log) into IndexedDB before we strip them from the snapshot.
  // Fire-and-forget — localStorage is the source of truth for what loads,
  // and the chart layer falls back gracefully when IDB lags by a tick.
  void flushHistoryFromWorld(world);

  const saveId = id ?? createSaveId(kind === "developer" ? "dev" : "game");
  const existing = registry.saves.find(save => save.id === saveId);
  const save = makeSave(saveId, name, kind, world, existing?.createdAt, viewTabs, panelScrollPositions);
  // Other slots in the registry were already compacted when they were saved
  // (their world.equity rings are empty; their world.traders[].log is empty).
  // Don't run compactPersistedSave on them every autosave — it allocates new
  // shallow copies for every equity + trader in every other save and does a
  // ton of redundant work. Just keep their existing references.
  const filteredExisting = kind === "developer"
    ? registry.saves.filter(item => item.kind !== "developer" || item.id === saveId)
    : registry.saves;
  const saves = existing
    ? filteredExisting.map(item => item.id === saveId ? save : item)
    : [...filteredExisting, save];
  const next: SaveRegistry = { version: SAVE_VERSION, activeId: saveId, saves };
  const write = writeRegistry(next);
  // Pass the live world so the in-memory history rings (which we just flushed
  // to IDB) survive the save round-trip. Without this, the caller would
  // receive the stripped snapshot and lose chart history until the next tick.
  return loadedFromSave(save, next, write, world);
}

export function createGameSlot(name: string, kind: SaveGameKind, world: World): LoadedGameSession {
  return saveGameSlot(null, name, kind, world);
}

export function loadGameSlot(id: string): LoadedGameSession | null {
  const registry = readRegistry();
  if (!registry) return null;
  const save = registry.saves.find(item => item.id === id);
  if (!save) return null;
  // Slots are stored already-compacted; no need to re-walk every world.
  const next: SaveRegistry = { version: SAVE_VERSION, activeId: id, saves: registry.saves };
  const write = writeRegistry(next);
  return loadedFromSave(save, next, write);
}

export function deleteGameSlot(id: string, createFallbackWorld: () => World): LoadedGameSession {
  const registry = readRegistry();
  if (!registry) {
    return {
      world: createFallbackWorld(),
      activeSaveId: null,
      gameName: "Voyager",
      gameKind: "standard",
      saveSlots: [],
      saveStatus: browserStorage() ? "error" : "unavailable",
      saveError: browserStorage() ? "Could not read save registry from localStorage." : "Browser localStorage is unavailable.",
    };
  }

  const removed = registry.saves.find(save => save.id === id);
  // Cascade-delete the slot's IndexedDB rows (chart history, trades, ship
  // log). Fire-and-forget — the registry write is what makes the slot
  // "gone" from the user's perspective; IDB cleanup just reclaims space.
  if (removed?.world.gameId) void deleteGameHistory(removed.world.gameId);

  // Same as loadGameSlot — surviving slots are already compacted.
  const saves = registry.saves.filter(save => save.id !== id);
  const active = saves.find(save => save.id === registry.activeId) ?? saves[0];
  if (active) {
    const next: SaveRegistry = { version: SAVE_VERSION, activeId: active.id, saves };
    const write = writeRegistry(next);
    return loadedFromSave(active, next, write);
  }

  const world = createFallbackWorld();
  const save = makeSave(createSaveId(), "Voyager", "standard", world);
  const next: SaveRegistry = { version: SAVE_VERSION, activeId: save.id, saves: [save] };
  const write = writeRegistry(next);
  // Fresh world after deleting the only save — same reasoning as above.
  return loadedFromSave(save, next, write, world);
}
