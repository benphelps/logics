import type { CrewModifiers, CrewRole, Hire, HireId, LocationDef, World } from "./types";
import { mulberry32, type Rng } from "./gen/rng";

// --- tunables --------------------------------------------------------------

export const HIRE_MAX_PER_STATION = 6;          // cap concurrent offers per station
export const HIRE_BASE_POST_CHANCE = 0.06;      // probability per station per tick (before tech/pop scaling)

// Expiry window — tier-3 stick around longer (rarer, premium offerings) so
// the player has time to save up.
const EXPIRY_BY_TIER: Record<number, number> = { 1: 100, 2: 140, 3: 200 };

// Modifiers are deliberately small — see "traits should be small in general".
// Each role has a pool of viable mods; tier dictates how many roll AND how
// hot they roll within their range.
const MOD_POOL_BY_ROLE: Record<CrewRole, (keyof CrewModifiers)[]> = {
  captain:   ["speedBonus", "rangeEfficiency", "sellPremium", "buyDiscount"],
  navigator: ["fuelCapacityBonus", "rangeEfficiency", "contractRewardBonus"],
  mechanic:  ["cargoCapacityBonus", "maintenanceDiscount", "fuelCapacityBonus"],
};

// Per-modifier roll envelope. value = lerp(min, max, tierFraction * variance).
const MOD_RANGE: Record<keyof CrewModifiers, [number, number]> = {
  cargoCapacityBonus:  [2, 6],
  fuelCapacityBonus:   [3, 8],
  speedBonus:          [1, 1],            // speed is integer; only spawns at T3
  hullBonus:           [1, 2],
  weaponPowerBonus:    [1, 2],
  rangeEfficiency:     [0.03, 0.10],
  buyDiscount:         [0.02, 0.05],
  sellPremium:         [0.02, 0.05],
  maintenanceDiscount: [0.04, 0.10],
  contractRewardBonus: [0.03, 0.10],
};

// Modifier weights for cost rollup — each modifier contributes to hire price.
const MOD_COST_WEIGHT: Record<keyof CrewModifiers, number> = {
  cargoCapacityBonus:  4_000,
  fuelCapacityBonus:   3_500,
  speedBonus:          18_000,
  hullBonus:           12_000,
  weaponPowerBonus:    18_000,
  rangeEfficiency:     250_000,           // multiplied by fractional value
  buyDiscount:         400_000,
  sellPremium:         400_000,
  maintenanceDiscount: 100_000,
  contractRewardBonus: 200_000,
};

// Role-baseline pricing (T1 with no mods). Tuned so each role becomes
// reachable on roughly this timeline of player progression:
//   captain   — within ~10 manual trades (post-tutorial)
//   mechanic  — shortly after, before maintenance debt grounds the ship
//   navigator — a stretch goal, but reachable without grinding past the point
//               where contracts would have been useful
const BASE_HIRE_BY_ROLE: Record<CrewRole, number> = {
  captain:   25_000,
  navigator: 70_000,         // was 140_000 — still too far from the early economy
  mechanic:  40_000,         // was 60_000  — wanted hireable before debt threshold bites
};
const BASE_WAGE_BY_ROLE: Record<CrewRole, number> = {
  captain:   4,
  navigator: 7,
  mechanic:  3,
};

// Tier multipliers stack on top of base + modifier-derived cost.
const TIER_HIRE_MULT: Record<number, number> = { 1: 1.0, 2: 1.5, 3: 2.4 };
const TIER_WAGE_MULT: Record<number, number> = { 1: 1.0, 2: 1.6, 3: 2.4 };
const MOD_COUNT_BY_TIER: Record<number, number> = { 1: 0, 2: 1, 3: 2 };

// Role posting weights — captains are the gateway, post most often. Mechanics
// next. Navigators rarest (also most expensive).
const ROLE_WEIGHTS: { role: CrewRole; weight: number }[] = [
  { role: "captain",   weight: 5 },
  { role: "mechanic",  weight: 3 },
  { role: "navigator", weight: 2 },
];

// --- name pool -------------------------------------------------------------

const FIRST_NAMES = [
  "Mira", "Renko", "Sora", "Eli", "Vela", "Hex", "Cole", "Yana",
  "Talia", "Jaro", "Iko", "Reva", "Nox", "Sela", "Brann", "Quin",
  "Aru", "Kara", "Olen", "Pavi", "Tess", "Ven", "Wes", "Zara",
];
const LAST_NAMES = [
  "Voss", "Marsh", "Tann", "Ortega", "Kade", "Valen", "Cross", "Holt",
  "Yune", "Drake", "Vex", "Stein", "Renn", "Mire", "Solas", "Grell",
  "Brae", "Finch", "Mott", "Ryker",
];

// --- helpers ---------------------------------------------------------------

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}

function pickWeighted<T>(rng: Rng, items: { item: T; weight: number }[]): T {
  const total = items.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (const x of items) {
    r -= x.weight;
    if (r <= 0) return x.item;
  }
  return items[items.length - 1].item;
}

function rollTier(rng: Rng, loc: LocationDef): 1 | 2 | 3 {
  // Tech determines the upper bound + bias: low-tech mostly T1, mid mostly T2,
  // high opens T3. Avoids overwhelming new players with premium hires they
  // can't afford while still letting them dream.
  const tech = loc.traits.techLevel;
  if (tech <= 3) return rng() < 0.85 ? 1 : 2;
  if (tech <= 5) return rng() < 0.55 ? 1 : rng() < 0.80 ? 2 : 3;
  return rng() < 0.30 ? 1 : rng() < 0.65 ? 2 : 3;
}

function rollModifiers(rng: Rng, role: CrewRole, tier: number): CrewModifiers {
  const count = MOD_COUNT_BY_TIER[tier] ?? 0;
  if (count === 0) return {};
  const pool = [...MOD_POOL_BY_ROLE[role]];
  const mods: CrewModifiers = {};
  // speedBonus only at tier 3 — drop it from the pool otherwise.
  const filteredPool = tier < 3 ? pool.filter(k => k !== "speedBonus") : pool;
  for (let i = 0; i < count && filteredPool.length > 0; i++) {
    const idx = Math.floor(rng() * filteredPool.length);
    const key = filteredPool.splice(idx, 1)[0];
    const [min, max] = MOD_RANGE[key];
    // T2 picks lower-half of range, T3 picks upper-half (slight tier-quality bias).
    const lo = tier === 3 ? (min + max) / 2 : min;
    const hi = tier === 3 ? max : (min + max) / 2;
    let v = lo + rng() * (hi - lo);
    // Integer-typed modifiers
    if (key === "cargoCapacityBonus" || key === "fuelCapacityBonus" || key === "speedBonus") {
      v = Math.max(1, Math.round(v));
    } else {
      v = Math.round(v * 100) / 100;
    }
    (mods as Record<string, number>)[key] = v;
  }
  return mods;
}

function modifierCost(mods: CrewModifiers): number {
  let total = 0;
  for (const [k, v] of Object.entries(mods)) {
    if (!v) continue;
    total += MOD_COST_WEIGHT[k as keyof CrewModifiers] * v;
  }
  return total;
}

function generateHire(rng: Rng, loc: LocationDef, world: World): Hire {
  const role = pickWeighted(rng, ROLE_WEIGHTS.map(r => ({ item: r.role, weight: r.weight })));
  const tier = rollTier(rng, loc);
  const modifiers = rollModifiers(rng, role, tier);
  const baseHire = BASE_HIRE_BY_ROLE[role];
  const baseWage = BASE_WAGE_BY_ROLE[role];
  const hireCost = Math.round((baseHire + modifierCost(modifiers)) * TIER_HIRE_MULT[tier]);
  const wagePerTick = Math.round(baseWage * TIER_WAGE_MULT[tier] * 10) / 10;

  const first = FIRST_NAMES[Math.floor(rng() * FIRST_NAMES.length)];
  const last = LAST_NAMES[Math.floor(rng() * LAST_NAMES.length)];
  const id: HireId = `h${world.nextHireId++}`;
  return {
    id,
    role,
    name: `${first} ${last}`,
    tier,
    hireCost,
    wagePerTick,
    modifiers,
    location: loc.id,
    postedTick: world.tick,
    expiresAt: world.tick + (EXPIRY_BY_TIER[tier] ?? 100),
  };
}

// --- per-tick generation + expiry ------------------------------------------

export function generateHires(world: World): Hire[] {
  const posted: Hire[] = [];
  // Count current offers per station so we don't blow past the per-station cap.
  const perLoc: Record<string, number> = {};
  for (const h of Object.values(world.hires)) perLoc[h.location] = (perLoc[h.location] ?? 0) + 1;

  for (const loc of Object.values(world.locations)) {
    if ((perLoc[loc.id] ?? 0) >= HIRE_MAX_PER_STATION) continue;
    // Deterministic per-(loc, tick) seed so re-running a tick from the same
    // state produces the same outcome.
    const rng = mulberry32(hashStr(loc.id) ^ world.tick);
    const popFactor = Math.min(2, Math.max(0.4, loc.population / 1000));
    const techFactor = Math.max(0.5, loc.traits.techLevel / 5);
    const chance = HIRE_BASE_POST_CHANCE * popFactor * techFactor;
    if (rng() > chance) continue;
    const h = generateHire(rng, loc, world);
    world.hires[h.id] = h;
    posted.push(h);
  }
  return posted;
}

export function expireHires(world: World): HireId[] {
  const expired: HireId[] = [];
  for (const h of Object.values(world.hires)) {
    if (world.tick >= h.expiresAt) {
      expired.push(h.id);
      delete world.hires[h.id];
    }
  }
  return expired;
}

// --- queries + actions -----------------------------------------------------

export function listHiresAt(world: World, location: string): Hire[] {
  return Object.values(world.hires)
    .filter(h => h.location === location)
    .sort((a, b) => (a.tier - b.tier) || (a.hireCost - b.hireCost));
}

// Convert a Hire (offer) into a CrewMember snapshot suitable for the ship.
// Strips offer-only metadata (location/expiresAt/postedTick).
export function snapshotFromHire(h: Hire): import("./types").CrewMember {
  return {
    id: h.id,                   // reuse id so UI can detect "this offer was the one I hired"
    role: h.role,
    name: h.name,
    tier: h.tier,
    hireCost: h.hireCost,
    wagePerTick: h.wagePerTick,
    modifiers: { ...h.modifiers },
  };
}

export function takeHire(world: World, hireId: HireId): Hire | null {
  const h = world.hires[hireId];
  if (!h) return null;
  delete world.hires[hireId];
  return h;
}
