import { create } from "zustand";
import type { World, LocationId, GoodId, TraderId } from "../sim/types";
import { createWorld } from "../sim/world";
import { tickWorld } from "../sim/tick";
import { executeTrade, type TradeOption } from "../sim/traders";

export type Tab = "markets" | "ships" | "locations" | "player";
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
}

export const useStore = create<UiState>((set, get) => ({
  world: createWorld(),
  speed: 0,
  tickEpoch: 0,
  selectedTab: "markets",
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
}));
