import { create } from "zustand";
import type { CrewMember, CrewRole, Equity, EquityId, Job, World, LocationId, GoodId, JobId, SyndicateId, Trader, TraderId, UpgradeSlot } from "../sim/types";
import type { ActiveNewsEvent } from "../sim/news/types";
import { createStartingWorld, DEFAULT_STARTING_WORLD, randomStartingWorldSeed } from "../sim/start";
import { generateWorld } from "../sim/gen/world";
import { makeStartingShip } from "../sim/data/player";
import { tickWorld } from "../sim/tick";
import {
  buyAtLocation,
  executeTrade,
  installUpgradeFromCargo as installUpgradeFromCargoAction,
  installUpgradeFromMarket as installUpgradeFromMarketAction,
  refuelManual,
  repairShip,
  removeInstalledUpgrade as removeInstalledUpgradeAction,
  sellAtLocation,
  travelTo,
  type TradeOption,
} from "../sim/traders";
import { abandonJob, acceptJob, collectTradeJob } from "../sim/jobs";
import { fireCrew, hireCrew, recomputeShipStats } from "../sim/crew";
import { deriveCrewIdentity } from "../sim/crewIdentity";
import { MILESTONES, replenishUnlockedUpgrades } from "../sim/milestones";
import { releaseCrewHeadshots } from "./headshots";
import { abandonPosition, adjustPlayerLimit, buyShares, cancelPlayerLimit, coverShares, placeLimitBuy, placeLimitSell, sellShares, setStopLoss, setTakeProfit, shortShares } from "../sim/stock";
import { openLongFuture as simOpenLongFuture, openShortFuture as simOpenShortFuture, closeFuture as simCloseFuture } from "../sim/stock/futures";
import { purchaseShip as simPurchaseShip } from "../sim/shipyards";
import {
  createGameSlot,
  deleteGameSlot,
  loadGameSlot,
  loadInitialGame,
  nextSaveName,
  saveGameSlot,
  type LoadedGameSession,
  type SaveGameKind,
  type SaveSlotSummary,
  type SaveStatus,
} from "./saveGames";

export type Speed = 0 | 1 | 4 | 16;

// Whether the new-game picker is replacing the current save (reset) or
// minting a new slot (create). Drives what confirmNewGame does on commit.
export type NewGameIntent = "create" | "reset";

export interface PendingNewGame {
  intent: NewGameIntent;
  seed: number;
  // Preview-only world, generated with the same seed the commit will use.
  // We never save or display it directly — the picker reads it for the
  // syndicate roster (so the player sees their actual choices for this
  // seed); confirmNewGame re-runs the seed through createStartingWorld
  // with the chosen syndicateId to produce the real, ageed world.
  previewWorld: World;
}

import {
  DEFAULT_VIEW_TABS,
  type AtlasMapTab,
  type AtlasSheetTab,
  type CommodityTab,
  type FleetTab,
  type LedgerTab,
  type MainViewTab,
  type PanelScrollPosition,
  type PanelScrollPositions,
  type PnoTab,
  type StockKindFilter,
  type ViewTabs,
} from "./viewTabs";
export type Tab = MainViewTab;
export type { AtlasMapTab, AtlasSheetTab, FleetTab, CommodityTab, LedgerTab, PanelScrollPosition, PanelScrollPositions, PnoTab, StockKindFilter, ViewTabs };

const initialGame = loadInitialGame(() => createStartingWorld());

// First-launch UX: if loadInitialGame had to synthesize a save from
// scratch (no registry / no active slot), open the syndicate picker
// immediately so the player still chooses their faction. The auto-
// generated world sits behind the modal as a placeholder; confirming
// the picker re-rolls the world with the chosen syndicate. Cancelling
// keeps the placeholder world (a sensible default).
function buildFreshStartPending(): PendingNewGame {
  const seed = randomStartingWorldSeed();
  const previewWorld = generateWorld({
    seed,
    locationCount: DEFAULT_STARTING_WORLD.locationCount,
    traderCount: DEFAULT_STARTING_WORLD.traderCount,
    player: null,
  });
  return { intent: "create", seed, previewWorld };
}
const initialPendingNewGame: PendingNewGame | null = initialGame.isFreshStart
  ? buildFreshStartPending()
  : null;

const AUTOSAVE_THROTTLE_MS = 2_000;
let pendingAutosave: ReturnType<typeof setTimeout> | null = null;
let lastAutosaveAt = 0;

function clearPendingAutosave(): void {
  if (pendingAutosave == null) return;
  clearTimeout(pendingAutosave);
  pendingAutosave = null;
}

function playerShip(world: World) {
  const id = world.player?.shipIds[0];
  return id ? world.traders[id] ?? null : null;
}

function selectedPlayerShipId(world: World, selectedTrader: TraderId | null): TraderId | undefined {
  const ids = world.player?.shipIds ?? [];
  return selectedTrader && ids.includes(selectedTrader) && world.traders[selectedTrader]
    ? selectedTrader
    : ids[0];
}

function devCrew(role: CrewRole, name: string, tier: number, modifiers: CrewMember["modifiers"]): CrewMember {
  const id = `dev-${role}`;
  const identity = deriveCrewIdentity(id);
  return {
    id,
    role,
    name,
    tier,
    hireCost: 0,
    wagePerTick: role === "captain" ? 120 : role === "navigator" ? 40 : 55,
    modifiers,
    sex: identity.sex,
    age: identity.age,
    race: identity.race,
  };
}

function sortedEquities(world: World, kind: Equity["kind"]): Equity[] {
  return Object.values(world.equities)
    .filter(eq => eq.kind === kind)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function devContractDestination(world: World, origin: LocationId): LocationId {
  const partsConsumer = Object.values(world.locations)
    .filter(loc => loc.id !== origin && loc.consumes.some(entry => entry.good === "parts"))
    .sort((a, b) => a.name.localeCompare(b.name))[0];
  if (partsConsumer) return partsConsumer.id;
  return Object.keys(world.locations).find(id => id !== origin) ?? origin;
}

// Two extra ships in the dev fleet so the multi-ship features
// (per-ship wallets, picker, per-ship stock positions, shipyard
// purchase flow) all have something to test against from a fresh dev
// state. Each ship has its own wallet, crew, and a distinct loadout
// so they're easy to tell apart at a glance.
function spawnDeveloperFleet(world: World, location: LocationId): void {
  if (!world.player) return;
  const haulerId = makePlayerShipId(world, "Dev Hauler");
  const hauler = makeStartingShip("Dev Hauler", location, 180_000);
  hauler.id = haulerId;
  hauler.pilot = "manual";
  hauler.shipClass = "hauler";
  hauler.baseCapacity = 160;
  hauler.baseSpeed = 0.95;
  hauler.baseFuelCapacity = 90;
  hauler.baseHull = 6;
  hauler.capacity = hauler.baseCapacity;
  hauler.speed = hauler.baseSpeed;
  hauler.fuelCapacity = hauler.baseFuelCapacity;
  hauler.hull = hauler.baseHull;
  hauler.currentFuel = { good: hauler.fuelTypes[0].good, qty: hauler.fuelCapacity };
  hauler.upgrades = { cargo: "upg_cargo_2", hull: "upg_hull_1" };
  hauler.crew = {
    captain: devCrew("captain", "Dev Hauler Pilot", 1, { speedBonus: 0.2 }),
    mechanic: devCrew("mechanic", "Dev Hauler Mechanic", 1, { maintenanceDiscount: 0.25 }),
  };
  recomputeShipStats(hauler);
  world.traders[hauler.id] = hauler;
  world.player.shipIds.push(hauler.id);

  const courierId = makePlayerShipId(world, "Dev Courier");
  const courier = makeStartingShip("Dev Courier", location, 95_000);
  courier.id = courierId;
  courier.pilot = "manual";
  courier.shipClass = "courier";
  courier.baseCapacity = 38;
  courier.baseSpeed = 1.9;
  courier.baseFuelCapacity = 35;
  courier.baseHull = 3;
  courier.capacity = courier.baseCapacity;
  courier.speed = courier.baseSpeed;
  courier.fuelCapacity = courier.baseFuelCapacity;
  courier.hull = courier.baseHull;
  courier.currentFuel = { good: courier.fuelTypes[0].good, qty: courier.fuelCapacity };
  courier.upgrades = { engine: "upg_engine_1", systems: "upg_systems_nav_1" };
  courier.traits = ["fuel-efficient"];
  courier.crew = {
    captain: devCrew("captain", "Dev Courier Pilot", 1, { speedBonus: 0.4 }),
    navigator: devCrew("navigator", "Dev Courier Nav", 1, { rangeEfficiency: 0.12 }),
  };
  recomputeShipStats(courier);
  world.traders[courier.id] = courier;
  world.player.shipIds.push(courier.id);
}

function makePlayerShipId(world: World, name: string): TraderId {
  const base = `p_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
  if (!world.traders[base]) return base;
  let i = 2;
  while (world.traders[`${base}_${i}`]) i += 1;
  return `${base}_${i}`;
}

function seedDeveloperCargo(world: World, ship: Trader): void {
  ship.cargo = [
    { good: "parts", qty: 8, source: ship.location, unitPrice: world.goods.parts?.basePrice ?? 35, purchasedAt: world.tick },
    { good: "grain", qty: 18, source: ship.location, unitPrice: world.goods.grain?.basePrice ?? 8, purchasedAt: world.tick },
    { good: "polymer", qty: 12, source: ship.location, unitPrice: world.goods.polymer?.basePrice ?? 6, purchasedAt: world.tick },
    { good: "electronics", qty: 4, source: ship.location, unitPrice: world.goods.electronics?.basePrice ?? 80, purchasedAt: world.tick },
    { good: "upg_engine_2", qty: 1, source: ship.location, unitPrice: world.goods.upg_engine_2?.basePrice ?? 30_000, purchasedAt: world.tick },
  ];
  ship.unloadingCargo = undefined;
}

function seedDeveloperContract(world: World, ship: Trader): void {
  const destination = devContractDestination(world, ship.location);
  const id = `j_dev_${world.nextJobId++}`;
  const job: Job = {
    id,
    kind: "shortage",
    tier: "medium",
    good: "parts",
    qty: 14,
    destination,
    reward: 8_400,
    penalty: 2_100,
    postedTick: world.tick,
    expiresAt: world.tick + 500,
    acceptedBy: ship.id,
    delivered: 0,
  };
  world.jobs[id] = job;
}

function seedDeveloperPositions(world: World, ship: Trader): void {
  if (!world.player) return;
  const station = sortedEquities(world, "station")[0];
  const syndicate = sortedEquities(world, "syndicate")[0];
  const commodity = sortedEquities(world, "commodity").find(eq => eq.underlyingId === "grain")
    ?? sortedEquities(world, "commodity")[0];

  // Seed positions onto the dev ship rather than the player-global record;
  // each ship now owns its own positions / trades / futures (only
  // achievements stay shared across the fleet).
  ship.stockPositions = {};
  if (station) {
    ship.stockPositions[station.id] = {
      equityId: station.id,
      kind: "long",
      shares: 24,
      avgEntryPrice: station.price * 0.92,
      openedAt: Math.max(0, world.tick - 42),
      stopLoss: station.price * 0.86,
      takeProfit: station.price * 1.18,
    };
  }
  if (commodity) {
    ship.stockPositions[commodity.id] = {
      equityId: commodity.id,
      kind: "long",
      shares: 40,
      avgEntryPrice: commodity.price * 1.08,
      openedAt: Math.max(0, world.tick - 27),
      stopLoss: commodity.price * 0.9,
      takeProfit: commodity.price * 1.16,
    };
  }
  if (syndicate) {
    ship.stockPositions[syndicate.id] = {
      equityId: syndicate.id,
      kind: "short",
      shares: 12,
      avgEntryPrice: syndicate.price * 1.12,
      openedAt: Math.max(0, world.tick - 18),
      stopLoss: syndicate.price * 1.2,
      takeProfit: syndicate.price * 0.88,
    };
  }

  const contract = Object.values(world.contracts ?? {})
    .filter(c => c.goodId === "grain" && world.tick < c.expiryTick)
    .sort((a, b) => a.expiryTick - b.expiryTick)[0];
  if (contract) {
    simOpenLongFuture(world, contract.id, 2, ship.id);
  }
}

function completeDeveloperCharters(world: World): void {
  if (!world.player) return;
  world.player.manualActionCount = Math.max(...Object.values(MILESTONES));
  replenishUnlockedUpgrades(world);
}

function createDeveloperWorld(): World {
  // Re-seed every time the dev state is created so the layout / lane
  // network / shipyard placements / NPC fleet / news pool re-roll on
  // each "Load Developer State" click. Production saves still use the
  // fixed DEFAULT_STARTING_WORLD.seed for determinism.
  const seed = Math.floor(Math.random() * 0x7fffffff);
  const world = createStartingWorld({ startingFunds: 250_000, seed });
  const ship = playerShip(world);
  if (!ship) return world;

  ship.funds = 100_000_000;
  ship.pilot = "manual";
  ship.crew = {
    navigator: devCrew("navigator", "Dev Navigator", 1, { rangeEfficiency: 0.08 }),
    mechanic: devCrew("mechanic", "Dev Mechanic", 1, { maintenanceDiscount: 0.45 }),
    captain: devCrew("captain", "Dev Pilot", 2, { speedBonus: 0.5 }),
  };
  spawnDeveloperFleet(world, ship.location);
  // Top-tier loadout — every slot gets the highest-tier (T4 legendary)
  // variant available, so the dev state shows what a fully kitted ship
  // does to stats, capacity, and the rarity-colored catalog.
  ship.upgrades = {
    cargo: "upg_cargo_atlas_3",
    engine: "upg_engine_3",
    fuel: "upg_fuel_3",
    hull: "upg_hull_nano_3",
    weapon: "upg_weapon_3",
    systems: "upg_systems_oracle_3",
  };
  recomputeShipStats(ship);
  ship.currentFuel = { good: "plasma", qty: ship.fuelCapacity };
  ship.maintenanceDebt = 0;
  seedDeveloperCargo(world, ship);
  seedDeveloperContract(world, ship);
  seedDeveloperPositions(world, ship);
  completeDeveloperCharters(world);
  return world;
}

interface UiState {
  world: World;
  speed: Speed;
  tickEpoch: number;
  activeSaveId: string | null;
  gameName: string;
  gameKind: SaveGameKind;
  saveSlots: SaveSlotSummary[];
  saveStatus: SaveStatus;
  saveError: string | null;
  selectedTab: Tab;
  selectedLocation: LocationId | null;
  selectedGood: GoodId | null;
  selectedTrader: TraderId | null;
  selectedEquity: EquityId | null;
  // Inner-tab state (synced + persisted with the save).
  fleetTab: FleetTab;
  commodityTab: CommodityTab;
  pnoTab: PnoTab;
  atlasSheetTab: AtlasSheetTab;
  atlasMapTab: AtlasMapTab;
  ledgerTab: LedgerTab;
  stockKindFilter: StockKindFilter;
  stockGuideEnabled: boolean;
  panelScrollPositions: PanelScrollPositions;
  lastError: string | null;
  // Toast queue — populated when tickWorld() returns spawned news events.
  // The toast component drains entries via dismissNewsToast as they auto-fade.
  newsToasts: ActiveNewsEvent[];
  // Pending new-game flow — non-null while the syndicate picker is open.
  // Holds the seed + a preview world the picker reads for its roster.
  pendingNewGame: PendingNewGame | null;

  setSpeed: (s: Speed) => void;
  togglePause: () => void;
  step: () => void;
  stepN: (n: number) => void;
  reset: () => void;
  saveCurrentGame: () => void;
  createGame: () => void;
  confirmNewGame: (syndicateId: SyndicateId) => void;
  cancelNewGame: () => void;
  loadGame: (id: string) => void;
  deleteGame: (id: string) => void;
  loadDeveloperState: () => void;
  selectTab: (t: Tab) => void;
  setFleetTab: (t: FleetTab) => void;
  setCommodityTab: (t: CommodityTab) => void;
  setPnoTab: (t: PnoTab) => void;
  setAtlasSheetTab: (t: AtlasSheetTab) => void;
  setAtlasMapTab: (t: AtlasMapTab) => void;
  setLedgerTab: (t: LedgerTab) => void;
  setStockKindFilter: (t: StockKindFilter) => void;
  setStockGuideEnabled: (enabled: boolean) => void;
  setPanelScrollPosition: (key: string, position: PanelScrollPosition) => void;
  selectLocation: (id: LocationId | null) => void;
  selectGood: (id: GoodId | null) => void;
  selectTrader: (id: TraderId | null) => void;
  executeOption: (traderId: TraderId, option: TradeOption) => void;
  setPilot: (traderId: TraderId, pilot: "manual" | "auto") => void;
  clearError: () => void;
  buy: (traderId: TraderId, good: GoodId, qty: number) => void;
  sell: (traderId: TraderId, good: GoodId, qty?: number) => void;
  refuel: (traderId: TraderId, qty?: number) => void;
  travel: (traderId: TraderId, dst: LocationId) => void;
  acceptJob: (jobId: JobId, traderId: TraderId) => void;
  collectJob: (jobId: JobId, traderId: TraderId) => void;
  abandonJob: (jobId: JobId) => void;
  hireCrew: (traderId: TraderId, candidateId: string) => void;
  fireCrew: (traderId: TraderId, role: CrewRole) => void;
  repairShip: (traderId: TraderId) => void;
  installUpgradeFromCargo: (traderId: TraderId, good: GoodId) => void;
  installUpgradeFromMarket: (traderId: TraderId, good: GoodId) => void;
  removeInstalledUpgrade: (traderId: TraderId, slot: UpgradeSlot) => void;
  selectEquity: (id: EquityId | null) => void;
  buyShares: (equityId: EquityId, qty: number) => void;
  sellShares: (equityId: EquityId, qty: number) => void;
  shortShares: (equityId: EquityId, qty: number) => void;
  coverShares: (equityId: EquityId, qty: number) => void;
  abandonPosition: (equityId: EquityId) => void;
  setStopLoss: (equityId: EquityId, price: number | null) => void;
  setTakeProfit: (equityId: EquityId, price: number | null) => void;
  placeLimitBuy: (equityId: EquityId, qty: number, limitPrice: number) => void;
  placeLimitSell: (equityId: EquityId, qty: number, limitPrice: number) => void;
  cancelLimit: (equityId: EquityId, orderId: string) => void;
  adjustLimit: (equityId: EquityId, orderId: string, qty: number, price: number) => void;
  // C-3 — futures actions. count = number of contracts. closeFuture
  // accepts an optional partial-close count; omitted = close the whole
  // position.
  openLongFuture: (contractId: EquityId, count: number) => void;
  openShortFuture: (contractId: EquityId, count: number) => void;
  closeFuture: (contractId: EquityId, count?: number) => void;
  // Buy a ship from a shipyard. Buyer is the currently-selected ship;
  // it must be docked at the same shipyard. Funds are debited from
  // that ship's wallet and the new ship is added to player.shipIds,
  // docked at the same yard with its own empty wallet.
  // Returns the new ship's id on success (so the caller can immediately
  // open a rename dialog or focus the freshly-bought ship), or null on
  // failure (lastError is also persisted in that case).
  purchaseShip: (blueprintId: string) => TraderId | null;
  // Rename an existing ship in the player's fleet. No-op if the ship
  // doesn't exist or isn't owned by the player. Empty/whitespace-only
  // names are ignored — caller should validate before invoking.
  renameShip: (shipId: TraderId, name: string) => void;
  dismissNewsToast: (uid: string) => void;
}

export const useStore = create<UiState>((set, get) => {
  const applyLoadedGame = (session: LoadedGameSession) => {
    clearPendingAutosave();
    const tabs = session.viewTabs ?? DEFAULT_VIEW_TABS;
    const scrollPositions = session.panelScrollPositions ?? {};
    set({
      world: session.world,
      activeSaveId: session.activeSaveId,
      gameName: session.gameName,
      gameKind: session.gameKind,
      saveSlots: session.saveSlots,
      saveStatus: session.saveStatus,
      saveError: session.saveError,
      speed: 0,
      tickEpoch: get().tickEpoch + 1,
      selectedLocation: null,
      selectedGood: null,
      selectedTrader: null,
      fleetTab: tabs.fleetTab,
      commodityTab: tabs.commodityTab,
      pnoTab: tabs.pnoTab,
      atlasSheetTab: tabs.atlasSheetTab,
      atlasMapTab: tabs.atlasMapTab,
      ledgerTab: tabs.ledgerTab,
      stockKindFilter: tabs.stockKindFilter,
      stockGuideEnabled: tabs.stockGuideEnabled,
      panelScrollPositions: { ...scrollPositions },
      lastError: null,
    });
  };

  const writeCurrentSave = () => {
    const current = get();
    const saved = saveGameSlot(
      current.activeSaveId,
      current.gameName,
      current.gameKind,
      current.world,
      currentViewTabs(current),
      current.panelScrollPositions,
    );
    lastAutosaveAt = Date.now();
    set({
      activeSaveId: saved.activeSaveId,
      gameName: saved.gameName,
      gameKind: saved.gameKind,
      saveSlots: saved.saveSlots,
      saveStatus: saved.saveStatus,
      saveError: saved.saveError,
    });
  };

  const currentViewTabs = (state: UiState): ViewTabs => ({
    fleetTab: state.fleetTab,
    commodityTab: state.commodityTab,
    pnoTab: state.pnoTab,
    atlasSheetTab: state.atlasSheetTab,
    atlasMapTab: state.atlasMapTab,
    ledgerTab: state.ledgerTab,
    stockKindFilter: state.stockKindFilter,
    stockGuideEnabled: state.stockGuideEnabled,
  });

  // Open the syndicate picker. Generates a preview world (without aging,
  // since we only need the syndicate roster for the picker) using a fresh
  // seed; confirmNewGame later re-runs the same seed through
  // createStartingWorld so the committed world matches what the player
  // saw in the picker.
  const openNewGameDialog = (intent: NewGameIntent) => {
    const seed = randomStartingWorldSeed();
    const previewWorld = generateWorld({
      seed,
      locationCount: DEFAULT_STARTING_WORLD.locationCount,
      traderCount: DEFAULT_STARTING_WORLD.traderCount,
      player: null,
    });
    set({ pendingNewGame: { intent, seed, previewWorld } });
  };

  const persistCurrentGame = (updates: Partial<Pick<UiState, "lastError" | "speed">> = {}, bumpEpoch = true, immediate = false) => {
    const current = get();
    if (bumpEpoch || Object.keys(updates).length > 0) {
      set({
        tickEpoch: current.tickEpoch + (bumpEpoch ? 1 : 0),
        ...updates,
      });
    }

    if (immediate) {
      clearPendingAutosave();
      writeCurrentSave();
      return;
    }

    if (pendingAutosave != null) return;
    const elapsed = Date.now() - lastAutosaveAt;
    const delay = Math.max(250, AUTOSAVE_THROTTLE_MS - elapsed);
    pendingAutosave = setTimeout(() => {
      pendingAutosave = null;
      writeCurrentSave();
    }, delay);
  };

  return {
    world: initialGame.world,
    speed: 0,
    tickEpoch: 0,
    activeSaveId: initialGame.activeSaveId,
    gameName: initialGame.gameName,
    gameKind: initialGame.gameKind,
    saveSlots: initialGame.saveSlots,
    saveStatus: initialGame.saveStatus,
    saveError: initialGame.saveError,
    selectedTab: "player",
    selectedLocation: null,
    selectedGood: null,
    selectedTrader: null,
    selectedEquity: null,
    fleetTab: initialGame.viewTabs?.fleetTab ?? DEFAULT_VIEW_TABS.fleetTab,
    commodityTab: initialGame.viewTabs?.commodityTab ?? DEFAULT_VIEW_TABS.commodityTab,
    pnoTab: initialGame.viewTabs?.pnoTab ?? DEFAULT_VIEW_TABS.pnoTab,
    atlasSheetTab: initialGame.viewTabs?.atlasSheetTab ?? DEFAULT_VIEW_TABS.atlasSheetTab,
    atlasMapTab: initialGame.viewTabs?.atlasMapTab ?? DEFAULT_VIEW_TABS.atlasMapTab,
    ledgerTab: initialGame.viewTabs?.ledgerTab ?? DEFAULT_VIEW_TABS.ledgerTab,
    stockKindFilter: initialGame.viewTabs?.stockKindFilter ?? DEFAULT_VIEW_TABS.stockKindFilter,
    stockGuideEnabled: initialGame.viewTabs?.stockGuideEnabled ?? DEFAULT_VIEW_TABS.stockGuideEnabled,
    panelScrollPositions: { ...(initialGame.panelScrollPositions ?? {}) },
    lastError: null,
    newsToasts: [],
    pendingNewGame: initialPendingNewGame,

    setSpeed: (s) => set({ speed: s }),
    togglePause: () => set({ speed: get().speed === 0 ? 1 : 0 }),
    step: () => {
      const w = get().world;
      const report = tickWorld(w);
      if (report.hiresExpired.length > 0) {
        releaseCrewHeadshots(get().activeSaveId, report.hiresExpired);
      }
      if (report.newsSpawned.length > 0) {
        set({ newsToasts: [...get().newsToasts, ...report.newsSpawned].slice(-6) });
      }
      persistCurrentGame();
    },
    stepN: (n) => {
      const w = get().world;
      const expired: string[] = [];
      const newsSpawned: ActiveNewsEvent[] = [];
      for (let i = 0; i < n; i++) {
        const report = tickWorld(w);
        if (report.hiresExpired.length > 0) expired.push(...report.hiresExpired);
        if (report.newsSpawned.length > 0) newsSpawned.push(...report.newsSpawned);
      }
      if (expired.length > 0) releaseCrewHeadshots(get().activeSaveId, expired);
      if (newsSpawned.length > 0) {
        set({ newsToasts: [...get().newsToasts, ...newsSpawned].slice(-6) });
      }
      persistCurrentGame();
    },
    dismissNewsToast: (uid) => {
      set({ newsToasts: get().newsToasts.filter(t => t.uid !== uid) });
    },
    reset: () => openNewGameDialog("reset"),
    saveCurrentGame: () => persistCurrentGame({ lastError: null }, false, true),
    createGame: () => openNewGameDialog("create"),
    confirmNewGame: (syndicateId) => {
      const pending = get().pendingNewGame;
      if (!pending) return;
      const world = createStartingWorld({ seed: pending.seed, syndicateId });
      if (pending.intent === "create") {
        clearPendingAutosave();
        const slots = get().saveSlots;
        const name = nextSaveName(slots, "Voyager");
        applyLoadedGame(createGameSlot(name, "standard", world));
      } else {
        clearPendingAutosave();
        const current = get();
        const saved = saveGameSlot(current.activeSaveId, current.gameName, "standard", world);
        set({
          world,
          activeSaveId: saved.activeSaveId,
          gameName: saved.gameName,
          gameKind: saved.gameKind,
          saveSlots: saved.saveSlots,
          saveStatus: saved.saveStatus,
          saveError: saved.saveError,
          tickEpoch: current.tickEpoch + 1,
          speed: 0,
          selectedLocation: null,
          selectedGood: null,
          selectedTrader: null,
          panelScrollPositions: {},
          lastError: null,
        });
      }
      set({ pendingNewGame: null });
    },
    cancelNewGame: () => set({ pendingNewGame: null }),
    loadGame: (id) => {
      clearPendingAutosave();
      const session = loadGameSlot(id);
      if (!session) {
        set({ lastError: "Save slot no longer exists.", saveStatus: "error", saveError: "Save slot no longer exists." });
        return;
      }
      applyLoadedGame(session);
    },
    deleteGame: (id) => applyLoadedGame(deleteGameSlot(id, () => createStartingWorld())),
    loadDeveloperState: () => {
      clearPendingAutosave();
      const slots = get().saveSlots;
      const existingDev = slots.find(slot => slot.kind === "developer") ?? null;
      const name = existingDev?.name ?? nextSaveName(slots, "Developer State");
      applyLoadedGame(saveGameSlot(existingDev?.id ?? null, name, "developer", createDeveloperWorld()));
    },
    selectTab: (t) => set({ selectedTab: t }),
    setFleetTab: (t) => { set({ fleetTab: t }); persistCurrentGame({}, false); },
    setCommodityTab: (t) => { set({ commodityTab: t }); persistCurrentGame({}, false); },
    setPnoTab: (t) => { set({ pnoTab: t }); persistCurrentGame({}, false); },
    setAtlasSheetTab: (t) => { set({ atlasSheetTab: t }); persistCurrentGame({}, false); },
    setAtlasMapTab: (t) => { set({ atlasMapTab: t }); persistCurrentGame({}, false); },
    setLedgerTab: (t) => { set({ ledgerTab: t }); persistCurrentGame({}, false); },
    setStockKindFilter: (t) => { set({ stockKindFilter: t }); persistCurrentGame({}, false); },
    setStockGuideEnabled: (enabled) => { set({ stockGuideEnabled: enabled }); persistCurrentGame({}, false, true); },
    setPanelScrollPosition: (key, position) => {
      if (!key) return;
      const top = Number.isFinite(position.top) ? Math.max(0, Math.round(position.top)) : 0;
      const left = Number.isFinite(position.left) ? Math.max(0, Math.round(position.left)) : 0;
      const current = get().panelScrollPositions;
      const existing = current[key];
      if (existing?.top === top && existing.left === left) return;
      set({ panelScrollPositions: { ...current, [key]: { top, left } } });
      persistCurrentGame({}, false);
    },
    selectLocation: (id) => set({ selectedLocation: id }),
    selectGood: (id) => set({ selectedGood: id }),
    selectTrader: (id) => set({ selectedTrader: id }),
    executeOption: (traderId, option) => {
      const w = get().world;
      const trader = w.traders[traderId];
      if (!trader) return;
      const result = executeTrade(w, trader, option);
      if (!result.ok) {
        persistCurrentGame({ lastError: result.reason });
      } else {
        persistCurrentGame({ lastError: null });
      }
    },
    setPilot: (traderId, pilot) => {
      const w = get().world;
      const trader = w.traders[traderId];
      if (!trader) return;
      trader.pilot = pilot;
      persistCurrentGame();
    },
    clearError: () => set({ lastError: null }),

    buy: (traderId, good, qty) => {
      const w = get().world;
      const t = w.traders[traderId]; if (!t) return;
      const r = buyAtLocation(w, t, good, qty);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    sell: (traderId, good, qty) => {
      const w = get().world;
      const t = w.traders[traderId]; if (!t) return;
      const r = sellAtLocation(w, t, good, qty);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    refuel: (traderId, qty) => {
      const w = get().world;
      const t = w.traders[traderId]; if (!t) return;
      const r = refuelManual(w, t, qty);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    travel: (traderId, dst) => {
      const w = get().world;
      const t = w.traders[traderId]; if (!t) return;
      const r = travelTo(w, t, dst);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    acceptJob: (jobId, traderId) => {
      const w = get().world;
      const r = acceptJob(w, jobId, traderId);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    collectJob: (jobId, traderId) => {
      const w = get().world;
      const r = collectTradeJob(w, jobId, traderId);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    abandonJob: (jobId) => {
      const w = get().world;
      const r = abandonJob(w, jobId);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    hireCrew: (traderId, candidateId) => {
      const w = get().world;
      const t = w.traders[traderId]; if (!t) return;
      const offer = w.hires[candidateId];
      const displacedId = offer ? t.crew?.[offer.role]?.id : undefined;
      const r = hireCrew(w, t, candidateId);
      if (r.ok && displacedId && displacedId !== candidateId) {
        releaseCrewHeadshots(get().activeSaveId, [displacedId]);
      }
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    fireCrew: (traderId, role) => {
      const w = get().world;
      const t = w.traders[traderId]; if (!t) return;
      const firedId = t.crew?.[role]?.id;
      const r = fireCrew(t, role);
      if (r.ok && firedId) releaseCrewHeadshots(get().activeSaveId, [firedId]);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    repairShip: (traderId) => {
      const w = get().world;
      const t = w.traders[traderId]; if (!t) return;
      const r = repairShip(w, t);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    installUpgradeFromCargo: (traderId, good) => {
      const w = get().world;
      const t = w.traders[traderId]; if (!t) return;
      const r = installUpgradeFromCargoAction(w, t, good);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    installUpgradeFromMarket: (traderId, good) => {
      const w = get().world;
      const t = w.traders[traderId]; if (!t) return;
      const r = installUpgradeFromMarketAction(w, t, good);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    removeInstalledUpgrade: (traderId, slot) => {
      const w = get().world;
      const t = w.traders[traderId]; if (!t) return;
      const r = removeInstalledUpgradeAction(w, t, slot);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    selectEquity: (id) => set({ selectedEquity: id }),
    buyShares: (equityId, qty) => {
      const w = get().world;
      const r = buyShares(w, equityId, qty, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    sellShares: (equityId, qty) => {
      const w = get().world;
      const r = sellShares(w, equityId, qty, undefined, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    shortShares: (equityId, qty) => {
      const w = get().world;
      const r = shortShares(w, equityId, qty, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    coverShares: (equityId, qty) => {
      const w = get().world;
      const r = coverShares(w, equityId, qty, undefined, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    abandonPosition: (equityId) => {
      const w = get().world;
      const r = abandonPosition(w, equityId, undefined, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    setStopLoss: (equityId, price) => {
      const w = get().world;
      const r = setStopLoss(w, equityId, price, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    setTakeProfit: (equityId, price) => {
      const w = get().world;
      const r = setTakeProfit(w, equityId, price, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    placeLimitBuy: (equityId, qty, limitPrice) => {
      const w = get().world;
      const r = placeLimitBuy(w, equityId, qty, limitPrice, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    placeLimitSell: (equityId, qty, limitPrice) => {
      const w = get().world;
      const r = placeLimitSell(w, equityId, qty, limitPrice, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    cancelLimit: (equityId, orderId) => {
      const w = get().world;
      const r = cancelPlayerLimit(w, equityId, orderId, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    adjustLimit: (equityId, orderId, qty, price) => {
      const w = get().world;
      const r = adjustPlayerLimit(w, equityId, orderId, qty, price, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    openLongFuture: (contractId, count) => {
      const w = get().world;
      const r = simOpenLongFuture(w, contractId, count, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    openShortFuture: (contractId, count) => {
      const w = get().world;
      const r = simOpenShortFuture(w, contractId, count, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    closeFuture: (contractId, count) => {
      const w = get().world;
      const r = simCloseFuture(w, contractId, count, selectedPlayerShipId(w, get().selectedTrader));
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    purchaseShip: (blueprintId) => {
      const w = get().world;
      const buyerId = selectedPlayerShipId(w, get().selectedTrader);
      if (!buyerId) {
        persistCurrentGame({ lastError: "No buying ship available." });
        return null;
      }
      const r = simPurchaseShip(w, blueprintId, buyerId);
      if (r.ok) {
        // Auto-pin the new ship in the picker so the player lands on
        // the freshly-bought ship and can immediately outfit it.
        set({ selectedTrader: r.shipId });
        persistCurrentGame({ lastError: null });
        return r.shipId;
      }
      persistCurrentGame({ lastError: r.reason });
      return null;
    },
    renameShip: (shipId, name) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      const w = get().world;
      const ship = w.traders[shipId];
      if (!ship) return;
      if (!w.player?.shipIds.includes(shipId)) return;
      ship.name = trimmed.slice(0, 32);
      persistCurrentGame({ lastError: null });
    },
  };
});

declare global {
  interface Window {
    __LOGICS_CAPTURE_STORE__?: typeof useStore;
  }
}

if (typeof window !== "undefined" && import.meta.env.DEV) {
  window.__LOGICS_CAPTURE_STORE__ = useStore;
}
