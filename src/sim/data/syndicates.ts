import type { SyndicateTrait, SyndicateTraitId } from "../types";

// Fixed catalog of passive perks. Each generated syndicate is tagged with
// one trait id; the player ship picks up the modifiers when its
// syndicateId matches. Keep modifier magnitudes in line with crew bonuses
// (single-stat hires) so the trait reads as flavor, not a power spike.
export const SYNDICATE_TRAITS: Record<SyndicateTraitId, SyndicateTrait> = {
  "free-traders": {
    id: "free-traders",
    label: "Free Traders",
    description: "Discount at member markets and a sliver of premium on sales.",
    modifiers: { buyDiscount: 0.04, sellPremium: 0.04 },
  },
  "deep-haulers": {
    id: "deep-haulers",
    label: "Deep Haulers",
    description: "Reinforced bays — every member ship carries more cargo.",
    modifiers: { cargoCapacityBonus: 25 },
  },
  "swift-couriers": {
    id: "swift-couriers",
    label: "Swift Couriers",
    description: "Tuned thrusters add a step of speed in lane.",
    modifiers: { speedBonus: 1 },
  },
  "fuel-conservators": {
    id: "fuel-conservators",
    label: "Fuel Conservators",
    description: "Efficient burns — fuel goes 15% further on every leg.",
    modifiers: { rangeEfficiency: 0.15 },
  },
  "expediters": {
    id: "expediters",
    label: "Expediters",
    description: "Drilled crews unload cargo faster at every port.",
    modifiers: { unloadSpeedBonus: 0.6 },
  },
  "engineers": {
    id: "engineers",
    label: "The Engineers' Guild",
    description: "Cheaper maintenance and a passive fuel trickle while docked.",
    modifiers: { maintenanceDiscount: 0.20, fuelRegenIdle: 0.5 },
  },
  "exchange-mavens": {
    id: "exchange-mavens",
    label: "Exchange Mavens",
    description: "Bonus on contract rewards and on dividend payouts.",
    modifiers: { contractRewardBonus: 0.15, dividendBonus: 0.05 },
  },
  "wardens": {
    id: "wardens",
    label: "The Wardens",
    description: "Patrol-grade plating and gunnery on every member hull.",
    modifiers: { hullBonus: 3, weaponPowerBonus: 2 },
  },
};

// Naming pool. World gen draws without replacement; the syndicate count is
// capped at 8 so this list comfortably covers any seed.
export const SYNDICATE_NAMES = [
  "Voss Cargo Syndicate",
  "Kestrel Shipping Group",
  "Outerguild Hauliers",
  "Marsh Combine",
  "Holt Freightline",
  "Antares Confederation",
  "Pelican Lines",
  "Brae Industries",
  "Helios Charter",
  "Nyx Convoy",
  "Tessera Trust",
  "Corvid Federacy",
];

// Accent colors. One per syndicate, drawn in order — keeps the atlas
// readable when bubbles overlap. Tuned for the dark atlas vignette so
// each tint stays visible against the parchment-grade backdrop.
export const SYNDICATE_ACCENTS = [
  "#76c7ff", // pale azure
  "#f0a35a", // amber
  "#9be7a4", // sage
  "#e07ad6", // orchid
  "#ffd166", // wheat
  "#7be0d2", // teal
  "#ff8a8a", // coral
  "#b39ddb", // lilac
];
