import { create } from "zustand";
import type { CrewRole, World, LocationId, GoodId, JobId, TraderId } from "../sim/types";
import { createWorld } from "../sim/world";
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
import { abandonJob, acceptJob } from "../sim/jobs";
import { fireCrew, hireCrew } from "../sim/crew";

export type Tab = "player" | "markets" | "locations";
export type Speed = 0 | 1 | 4 | 16;

interface UiState {
  world: World;
  speed: Speed;
  tickEpoch: number;
  selectedTab: Tab;
  selectedLocation: LocationId | null;
  selectedGood: GoodId | null;
  selectedTrader: TraderId | null;
  lastError: string | null;

  setSpeed: (s: Speed) => void;
  togglePause: () => void;
  step: () => void;
  stepN: (n: number) => void;
  reset: () => void;
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
  abandonJob: (jobId: JobId) => void;
  hireCrew: (traderId: TraderId, candidateId: string) => void;
  fireCrew: (traderId: TraderId, role: CrewRole) => void;
  repairShip: (traderId: TraderId) => void;
  installUpgradeFromCargo: (traderId: TraderId, good: GoodId) => void;
  installUpgradeFromMarket: (traderId: TraderId, good: GoodId) => void;
}

export const useStore = create<UiState>((set, get) => ({
  world: createWorld(),
  speed: 0,
  tickEpoch: 0,
  selectedTab: "player",
  selectedLocation: null,
  selectedGood: null,
  selectedTrader: null,
  lastError: null,

  setSpeed: (s) => set({ speed: s }),
  togglePause: () => set({ speed: get().speed === 0 ? 1 : 0 }),
  step: () => {
    const w = get().world;
    tickWorld(w);
    set({ tickEpoch: get().tickEpoch + 1 });
  },
  stepN: (n) => {
    const w = get().world;
    for (let i = 0; i < n; i++) tickWorld(w);
    set({ tickEpoch: get().tickEpoch + 1 });
  },
  reset: () => set({ world: createWorld(), tickEpoch: 0, speed: 0, lastError: null }),
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
      set({ lastError: result.reason, tickEpoch: get().tickEpoch + 1 });
    } else {
      set({ lastError: null, tickEpoch: get().tickEpoch + 1 });
    }
  },
  setPilot: (traderId, pilot) => {
    const w = get().world;
    const trader = w.traders[traderId];
    if (!trader) return;
    trader.pilot = pilot;
    set({ tickEpoch: get().tickEpoch + 1 });
  },
  clearError: () => set({ lastError: null }),

  buy: (traderId, good, qty) => {
    const w = get().world;
    const t = w.traders[traderId]; if (!t) return;
    const r = buyAtLocation(w, t, good, qty);
    set({ lastError: r.ok ? null : r.reason, tickEpoch: get().tickEpoch + 1 });
  },
  sell: (traderId, good, qty) => {
    const w = get().world;
    const t = w.traders[traderId]; if (!t) return;
    const r = sellAtLocation(w, t, good, qty);
    set({ lastError: r.ok ? null : r.reason, tickEpoch: get().tickEpoch + 1 });
  },
  refuel: (traderId, qty) => {
    const w = get().world;
    const t = w.traders[traderId]; if (!t) return;
    const r = refuelManual(w, t, qty);
    set({ lastError: r.ok ? null : r.reason, tickEpoch: get().tickEpoch + 1 });
  },
  travel: (traderId, dst) => {
    const w = get().world;
    const t = w.traders[traderId]; if (!t) return;
    const r = travelTo(w, t, dst);
    set({ lastError: r.ok ? null : r.reason, tickEpoch: get().tickEpoch + 1 });
  },
  acceptJob: (jobId, traderId) => {
    const w = get().world;
    const r = acceptJob(w, jobId, traderId);
    set({ lastError: r.ok ? null : r.reason, tickEpoch: get().tickEpoch + 1 });
  },
  abandonJob: (jobId) => {
    const w = get().world;
    const r = abandonJob(w, jobId);
    set({ lastError: r.ok ? null : r.reason, tickEpoch: get().tickEpoch + 1 });
  },
  hireCrew: (traderId, candidateId) => {
    const w = get().world;
    const t = w.traders[traderId]; if (!t) return;
    const r = hireCrew(w, t, candidateId);
    set({ lastError: r.ok ? null : r.reason, tickEpoch: get().tickEpoch + 1 });
  },
  fireCrew: (traderId, role) => {
    const w = get().world;
    const t = w.traders[traderId]; if (!t) return;
    const r = fireCrew(t, role);
    set({ lastError: r.ok ? null : r.reason, tickEpoch: get().tickEpoch + 1 });
  },
  repairShip: (traderId) => {
    const w = get().world;
    const t = w.traders[traderId]; if (!t) return;
    const r = repairShip(w, t);
    set({ lastError: r.ok ? null : r.reason, tickEpoch: get().tickEpoch + 1 });
  },
  installUpgradeFromCargo: (traderId, good) => {
    const w = get().world;
    const t = w.traders[traderId]; if (!t) return;
    const r = installUpgradeFromCargoAction(w, t, good);
    set({ lastError: r.ok ? null : r.reason, tickEpoch: get().tickEpoch + 1 });
  },
  installUpgradeFromMarket: (traderId, good) => {
    const w = get().world;
    const t = w.traders[traderId]; if (!t) return;
    const r = installUpgradeFromMarketAction(w, t, good);
    set({ lastError: r.ok ? null : r.reason, tickEpoch: get().tickEpoch + 1 });
  },
}));
