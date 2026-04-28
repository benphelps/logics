import type { World } from "../sim/types";
import { ensureStockMarket } from "../sim/stock";

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

// Saves predating later mechanics (treasuries, stock market, long/short
// positions) won't have those fields. Backfill on load so the rest of the
// sim doesn't blow up on `Object.keys(undefined)`. Treasuries get
// initialized lazily inside `tickTreasuries`, so just the stock market
// + portfolio shape need explicit backfill.
function migrateLoadedWorld(world: World): World {
  if (!world.equities) world.equities = {};
  if (!world.syndicates) world.syndicates = {};
  ensureStockMarket(world);
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

function makeSave(id: string, name: string, kind: SaveGameKind, world: World, createdAt = Date.now()): PersistedSaveGame {
  const now = Date.now();
  return {
    version: SAVE_VERSION,
    id,
    name,
    kind,
    tick: world.tick,
    createdAt,
    updatedAt: now,
    world: cloneWorld(world),
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

export function saveGameSlot(id: string | null, name: string, kind: SaveGameKind, world: World): LoadedGameSession {
  const registry = readRegistry();
  if (!registry) {
    return {
      world,
      activeSaveId: id,
      gameName: name,
      gameKind: kind,
      saveSlots: [],
      saveStatus: browserStorage() ? "error" : "unavailable",
    };
  }

  const saveId = id ?? createSaveId(kind === "developer" ? "dev" : "game");
  const existing = registry.saves.find(save => save.id === saveId);
  const save = makeSave(saveId, name, kind, world, existing?.createdAt);
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
