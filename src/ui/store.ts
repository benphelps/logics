import { create } from "zustand";
import type { CrewMember, CrewRole, EquityId, World, LocationId, GoodId, JobId, TraderId } from "../sim/types";
import { createStartingWorld } from "../sim/start";
import { tickWorld } from "../sim/tick";
import {
  buyAtLocation,
  executeTrade,
  installUpgradeFromCargo as installUpgradeFromCargoAction,
  installUpgradeFromMarket as installUpgradeFromMarketAction,
  refuelManual,
  repairShip,
  sellAtLocation,
  travelTo,
  type TradeOption,
} from "../sim/traders";
import { abandonJob, acceptJob, collectTradeJob } from "../sim/jobs";
import { fireCrew, hireCrew, recomputeShipStats } from "../sim/crew";
import { abandonPosition, adjustPlayerLimit, buyShares, cancelPlayerLimit, coverShares, placeLimitBuy, placeLimitSell, sellShares, setStopLoss, setTakeProfit, shortShares } from "../sim/stock";
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

export type Tab = "player" | "markets" | "locations" | "stocks";
export type Speed = 0 | 1 | 4 | 16;

const initialGame = loadInitialGame(() => createStartingWorld());
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
  return {
    id: `dev-${role}`,
    role,
    name,
    tier,
    hireCost: 0,
    wagePerTick: role === "captain" ? 120 : role === "navigator" ? 40 : 55,
    modifiers,
  };
}

function createDeveloperWorld(): World {
  const world = createStartingWorld({ startingFunds: 250_000 });
  const ship = playerShip(world);
  if (!ship) return world;

  ship.funds = 250_000;
  ship.pilot = "manual";
  ship.crew = {
    navigator: devCrew("navigator", "Dev Navigator", 1, { rangeEfficiency: 0.08 }),
    mechanic: devCrew("mechanic", "Dev Mechanic", 1, { maintenanceDiscount: 0.45 }),
    captain: devCrew("captain", "Dev Pilot", 2, { speedBonus: 0.5 }),
  };
  ship.upgrades = {
    cargo: "upg_cargo_2",
    engine: "upg_engine_2",
    fuel: "upg_fuel_2",
    hull: "upg_hull_1",
    weapon: "upg_weapon_1",
  };
  recomputeShipStats(ship);
  ship.currentFuel = { good: "plasma", qty: ship.fuelCapacity };
  ship.maintenanceDebt = 0;
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
  selectedTab: Tab;
  selectedLocation: LocationId | null;
  selectedGood: GoodId | null;
  selectedTrader: TraderId | null;
  selectedEquity: EquityId | null;
  lastError: string | null;

  setSpeed: (s: Speed) => void;
  togglePause: () => void;
  step: () => void;
  stepN: (n: number) => void;
  reset: () => void;
  saveCurrentGame: () => void;
  createGame: () => void;
  loadGame: (id: string) => void;
  deleteGame: (id: string) => void;
  loadDeveloperState: () => void;
  selectTab: (t: Tab) => void;
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
}

export const useStore = create<UiState>((set, get) => {
  const applyLoadedGame = (session: LoadedGameSession) => {
    clearPendingAutosave();
    set({
      world: session.world,
      activeSaveId: session.activeSaveId,
      gameName: session.gameName,
      gameKind: session.gameKind,
      saveSlots: session.saveSlots,
      saveStatus: session.saveStatus,
      speed: 0,
      tickEpoch: get().tickEpoch + 1,
      selectedLocation: null,
      selectedGood: null,
      selectedTrader: null,
      lastError: null,
    });
  };

  const writeCurrentSave = () => {
    const current = get();
    const saved = saveGameSlot(current.activeSaveId, current.gameName, current.gameKind, current.world);
    lastAutosaveAt = Date.now();
    set({
      activeSaveId: saved.activeSaveId,
      gameName: saved.gameName,
      gameKind: saved.gameKind,
      saveSlots: saved.saveSlots,
      saveStatus: saved.saveStatus,
    });
  };

  const persistCurrentGame = (updates: Partial<Pick<UiState, "lastError" | "speed">> = {}, bumpEpoch = true, immediate = false) => {
    const current = get();
    set({
      tickEpoch: current.tickEpoch + (bumpEpoch ? 1 : 0),
      ...updates,
    });

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
    selectedTab: "player",
    selectedLocation: null,
    selectedGood: null,
    selectedTrader: null,
    selectedEquity: null,
    lastError: null,

    setSpeed: (s) => set({ speed: s }),
    togglePause: () => set({ speed: get().speed === 0 ? 1 : 0 }),
    step: () => {
      const w = get().world;
      tickWorld(w);
      persistCurrentGame();
    },
    stepN: (n) => {
      const w = get().world;
      for (let i = 0; i < n; i++) tickWorld(w);
      persistCurrentGame();
    },
    reset: () => {
      clearPendingAutosave();
      const current = get();
      const world = createStartingWorld();
      const saved = saveGameSlot(current.activeSaveId, current.gameName, "standard", world);
      set({
        world,
        activeSaveId: saved.activeSaveId,
        gameName: saved.gameName,
        gameKind: saved.gameKind,
        saveSlots: saved.saveSlots,
        saveStatus: saved.saveStatus,
        tickEpoch: current.tickEpoch + 1,
        speed: 0,
        selectedLocation: null,
        selectedGood: null,
        selectedTrader: null,
        lastError: null,
      });
    },
    saveCurrentGame: () => persistCurrentGame({ lastError: null }, false, true),
    createGame: () => {
      clearPendingAutosave();
      const slots = get().saveSlots;
      const name = nextSaveName(slots, "Voyager");
      applyLoadedGame(createGameSlot(name, "standard", createStartingWorld()));
    },
    loadGame: (id) => {
      clearPendingAutosave();
      const session = loadGameSlot(id);
      if (!session) {
        set({ lastError: "Save slot no longer exists.", saveStatus: "error" });
        return;
      }
      applyLoadedGame(session);
    },
    deleteGame: (id) => applyLoadedGame(deleteGameSlot(id, () => createStartingWorld())),
    loadDeveloperState: () => {
      clearPendingAutosave();
      const slots = get().saveSlots;
      const name = nextSaveName(slots, "Developer State");
      applyLoadedGame(createGameSlot(name, "developer", createDeveloperWorld()));
    },
    selectTab: (t) => set({ selectedTab: t }),
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
      const r = hireCrew(w, t, candidateId);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    fireCrew: (traderId, role) => {
      const w = get().world;
      const t = w.traders[traderId]; if (!t) return;
      const r = fireCrew(t, role);
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
      const r = setStopLoss(w, equityId, price);
      persistCurrentGame({ lastError: r.ok ? null : r.reason });
    },
    setTakeProfit: (equityId, price) => {
      const w = get().world;
      const r = setTakeProfit(w, equityId, price);
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
  };
});
