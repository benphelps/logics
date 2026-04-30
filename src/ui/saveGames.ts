import type { CrewMember, Hire, World } from "../sim/types";
import { ensureStockMarket } from "../sim/stock";
import { warmUpBook } from "../sim/stock/agents";
import { deriveCrewIdentity } from "../sim/crewIdentity";
import { normalizeViewTabs, type ViewTabs } from "./viewTabs";

const SAVE_REGISTRY_KEY = "logics.saveGames.v1";
const SAVE_VERSION = 1;

export type SaveGameKind = "standard" | "developer";
export type SaveStatus = "saved" | "unavailable" | "error";

export interface SaveSlotSummary {
  id: string;
  name: string;
  kind: SaveGameKind;
  tick: number;
  createdAt: number;
  updatedAt: number;
}

interface PersistedSaveGame extends SaveSlotSummary {
  version: typeof SAVE_VERSION;
  world: World;
  // Optional so older saves load cleanly — the store falls back to
  // defaults when missing.
  viewTabs?: ViewTabs;
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
  viewTabs?: ViewTabs;
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

// Compact a world before serializing to localStorage. With C-1..C-6 the
// universe lists 80+ equities and each one keeps a recentTrades buffer,
// a price history capped at SHARE_PRICE_HISTORY_MAX, and an order book
// of agent quotes. Across multiple save slots that can blow past the
// ~5 MB localStorage origin quota, at which point setItem throws and
// the save silently fails.
//
// Strip only the things rebuilt within ~4 ticks of running:
//   - Order book entries with a TTL — agent quotes that re-post on a
//     4-tick cadence. Player limit orders (no TTL) survive untouched.
//   - Trader logs trimmed to the most recent entries.
// Keep:
//   - Equity.history (the sparkline data, capped at 150 in the sim).
//   - Equity.recentTrades (Time & Sales tape, capped at 100). Useful
//     to see immediately after a reload.
//   - Player trade ledger (capped at TRADE_LEDGER_MAX in the sim).
function compactWorldForSave(world: World): World {
  const w = cloneWorld(world);
  if (w.orderBooks) {
    for (const book of Object.values(w.orderBooks)) {
      book.bids = book.bids.filter(o => o.ttl == null);
      book.asks = book.asks.filter(o => o.ttl == null);
    }
  }
  for (const t of Object.values(w.traders)) {
    if (t.log && t.log.length > 20) t.log = t.log.slice(-20);
  }
  return w;
}

// Saves predating later mechanics (treasuries, stock market, long/short
// positions) won't have those fields. Backfill on load so the rest of the
// sim doesn't blow up on `Object.keys(undefined)`. Treasuries get
// initialized lazily inside `tickTreasuries`, so just the stock market
// + portfolio shape need explicit backfill.
function migrateLoadedWorld(world: World): World {
  if (!world.equities) world.equities = {};
  if (!world.syndicates) world.syndicates = {};
  ensureStockMarket(world);
  backfillCrewIdentity(world);
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
  }
  return world;
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

function readRegistry(): SaveRegistry | null {
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(SAVE_REGISTRY_KEY);
    if (!raw) return { version: SAVE_VERSION, activeId: null, saves: [] };
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed) || parsed.version !== SAVE_VERSION || !Array.isArray(parsed.saves)) return null;
    const saves = parsed.saves.filter(isPersistedSave);
    const activeId = typeof parsed.activeId === "string" ? parsed.activeId : null;
    return { version: SAVE_VERSION, activeId, saves };
  } catch {
    return null;
  }
}

function writeRegistry(registry: SaveRegistry): SaveStatus {
  const storage = browserStorage();
  if (!storage) return "unavailable";
  try {
    storage.setItem(SAVE_REGISTRY_KEY, JSON.stringify(registry));
    return "saved";
  } catch {
    return "error";
  }
}

function summarize(save: PersistedSaveGame): SaveSlotSummary {
  return {
    id: save.id,
    name: save.name,
    kind: save.kind,
    tick: save.world.tick,
    createdAt: save.createdAt,
    updatedAt: save.updatedAt,
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

function makeSave(id: string, name: string, kind: SaveGameKind, world: World, createdAt = Date.now(), viewTabs?: ViewTabs): PersistedSaveGame {
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
  };
}

function loadedFromSave(save: PersistedSaveGame, registry: SaveRegistry, status: SaveStatus): LoadedGameSession {
  return {
    world: migrateLoadedWorld(cloneWorld(save.world)),
    activeSaveId: save.id,
    gameName: save.name,
    gameKind: save.kind,
    saveSlots: summaries(registry),
    saveStatus: status,
    viewTabs: save.viewTabs ? normalizeViewTabs(save.viewTabs) : undefined,
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
    };
  }

  const active = registry.saves.find(save => save.id === registry.activeId) ?? registry.saves[0];
  if (active) return loadedFromSave(active, registry, "saved");

  const world = fallbackWorld();
  const save = makeSave(createSaveId(), "Voyager", "standard", world);
  const next: SaveRegistry = { version: SAVE_VERSION, activeId: save.id, saves: [save] };
  const status = writeRegistry(next);
  return loadedFromSave(save, next, status);
}

export function saveGameSlot(id: string | null, name: string, kind: SaveGameKind, world: World, viewTabs?: ViewTabs): LoadedGameSession {
  const registry = readRegistry();
  if (!registry) {
    return {
      world,
      activeSaveId: id,
      gameName: name,
      gameKind: kind,
      saveSlots: [],
      saveStatus: browserStorage() ? "error" : "unavailable",
      viewTabs,
    };
  }

  const saveId = id ?? createSaveId(kind === "developer" ? "dev" : "game");
  const existing = registry.saves.find(save => save.id === saveId);
  const save = makeSave(saveId, name, kind, world, existing?.createdAt, viewTabs);
  const saves = existing
    ? registry.saves.map(item => item.id === saveId ? save : item)
    : [...registry.saves, save];
  const next: SaveRegistry = { version: SAVE_VERSION, activeId: saveId, saves };
  const status = writeRegistry(next);
  return loadedFromSave(save, next, status);
}

export function createGameSlot(name: string, kind: SaveGameKind, world: World): LoadedGameSession {
  return saveGameSlot(null, name, kind, world);
}

export function loadGameSlot(id: string): LoadedGameSession | null {
  const registry = readRegistry();
  if (!registry) return null;
  const save = registry.saves.find(item => item.id === id);
  if (!save) return null;
  const next: SaveRegistry = { ...registry, activeId: id };
  const status = writeRegistry(next);
  return loadedFromSave(save, next, status);
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
    };
  }

  const saves = registry.saves.filter(save => save.id !== id);
  const active = saves.find(save => save.id === registry.activeId) ?? saves[0];
  if (active) {
    const next: SaveRegistry = { version: SAVE_VERSION, activeId: active.id, saves };
    const status = writeRegistry(next);
    return loadedFromSave(active, next, status);
  }

  const world = createFallbackWorld();
  const save = makeSave(createSaveId(), "Voyager", "standard", world);
  const next: SaveRegistry = { version: SAVE_VERSION, activeId: save.id, saves: [save] };
  const status = writeRegistry(next);
  return loadedFromSave(save, next, status);
}
