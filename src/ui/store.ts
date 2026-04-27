import { create } from "zustand";
import type { World, LocationId, GoodId, TraderId } from "../sim/types";
import { createWorld } from "../sim/world";
import { tickWorld } from "../sim/tick";
import { buyAtLocation, executeTrade, refuelManual, sellAtLocation, travelTo, type TradeOption } from "../sim/traders";

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
  reset: () => void;
  selectTab: (t: Tab) => void;
  selectLocation: (id: LocationId | null) => void;
  selectGood: (id: GoodId | null) => void;
  selectTrader: (id: TraderId | null) => void;
  executeOption: (traderId: TraderId, option: TradeOption) => void;
  setPilot: (traderId: TraderId, pilot: "manual" | "auto") => void;
  clearError: () => void;
  buy: (traderId: TraderId, good: GoodId, qty: number) => void;
  sell: (traderId: TraderId, qty?: number) => void;
  refuel: (traderId: TraderId, qty?: number) => void;
  travel: (traderId: TraderId, dst: LocationId) => void;
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
  sell: (traderId, qty) => {
    const w = get().world;
    const t = w.traders[traderId]; if (!t) return;
    const r = sellAtLocation(w, t, qty);
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
}));
