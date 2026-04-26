import { create } from "zustand";
import type { World, LocationId, GoodId, TraderId } from "../sim/types";
import { createWorld } from "../sim/world";
import { tickWorld } from "../sim/tick";

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

  setSpeed: (s: Speed) => void;
  togglePause: () => void;
  step: () => void;
  reset: () => void;
  selectTab: (t: Tab) => void;
  selectLocation: (id: LocationId | null) => void;
  selectGood: (id: GoodId | null) => void;
  selectTrader: (id: TraderId | null) => void;
}

export const useStore = create<UiState>((set, get) => ({
  world: createWorld(),
  speed: 0,
  tickEpoch: 0,
  selectedTab: "markets",
  selectedLocation: null,
  selectedGood: null,
  selectedTrader: null,

  setSpeed: (s) => set({ speed: s }),
  togglePause: () => set({ speed: get().speed === 0 ? 1 : 0 }),
  step: () => {
    const w = get().world;
    tickWorld(w);
    set({ tickEpoch: get().tickEpoch + 1 });
  },
  reset: () => set({ world: createWorld(), tickEpoch: 0, speed: 0 }),
  selectTab: (t) => set({ selectedTab: t }),
  selectLocation: (id) => set({ selectedLocation: id }),
  selectGood: (id) => set({ selectedGood: id }),
  selectTrader: (id) => set({ selectedTrader: id }),
}));
