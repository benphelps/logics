import { describe, expect, it } from "vitest";
import { recomputeShipStats } from "./crew";
import { chargeDockingFee, applyIdlePerks } from "./economy";
import { buyAtLocation, installUpgradeFromCargo, installUpgradeFromMarket, removeInstalledUpgrade, sellAtLocation, travelTo, UNLOAD_TICKS } from "./traders";
import { tickN } from "./tick";
import { createWorld } from "./world";

function playerShip(world: ReturnType<typeof createWorld>) {
  return world.traders[world.player!.shipIds[0]];
}

describe("ship upgrades", () => {
  it("buys and installs a station module directly into the matching slot", () => {
    const world = createWorld();
    const ship = playerShip(world);
    ship.funds = 100_000;
    world.markets.haven.stock.upg_cargo_1 = 1;
    world.markets.haven.prices.upg_cargo_1 = 8_000;

    const baseCapacity = ship.capacity;
    const result = installUpgradeFromMarket(world, ship, "upg_cargo_1");

    expect(result.ok).toBe(true);
    expect(ship.upgrades?.cargo).toBe("upg_cargo_1");
    expect(ship.capacity).toBe(baseCapacity + 15);
    expect(ship.funds).toBe(92_000);
    expect(world.markets.haven.stock.upg_cargo_1).toBe(0);
  });

  it("keeps upgrade goods tradable as normal cargo", () => {
    const world = createWorld();
    const ship = playerShip(world);
    ship.funds = 100_000;
    world.markets.haven.stock.upg_engine_1 = 1;
    world.markets.haven.prices.upg_engine_1 = 10_000;

    expect(buyAtLocation(world, ship, "upg_engine_1", 1).ok).toBe(true);
    expect(ship.cargo).toContainEqual(expect.objectContaining({ good: "upg_engine_1", qty: 1 }));

    const fundsAfterBuy = ship.funds;
    expect(sellAtLocation(world, ship, "upg_engine_1").ok).toBe(true);
    expect(ship.cargo.some(l => l.good === "upg_engine_1")).toBe(false);
    // Sale drips over UNLOAD_TICKS; payment lands by the time the buffer empties.
    tickN(world, UNLOAD_TICKS);
    expect(ship.unloadingCargo ?? []).toEqual([]);
    expect(ship.funds).toBeGreaterThan(fundsAfterBuy);
  });

  it("installs an upgrade from cargo without spending again", () => {
    const world = createWorld();
    const ship = playerShip(world);
    ship.funds = 100_000;
    world.markets.haven.stock.upg_fuel_1 = 1;
    world.markets.haven.prices.upg_fuel_1 = 7_500;

    expect(buyAtLocation(world, ship, "upg_fuel_1", 1).ok).toBe(true);
    const fundsAfterBuy = ship.funds;
    const result = installUpgradeFromCargo(world, ship, "upg_fuel_1");

    expect(result.ok).toBe(true);
    expect(ship.upgrades?.fuel).toBe("upg_fuel_1");
    expect(ship.fuelCapacity).toBe((ship.baseFuelCapacity ?? 60) + 15);
    expect(ship.cargo.some(l => l.good === "upg_fuel_1")).toBe(false);
    expect(ship.funds).toBe(fundsAfterBuy);
  });

  it("replaces one module per slot and moves the old module into cargo", () => {
    const world = createWorld();
    const ship = playerShip(world);
    ship.funds = 200_000;
    world.markets.haven.stock.upg_cargo_1 = 1;
    world.markets.haven.stock.upg_cargo_2 = 1;
    world.markets.haven.prices.upg_cargo_1 = 8_000;
    world.markets.haven.prices.upg_cargo_2 = 24_000;

    expect(installUpgradeFromMarket(world, ship, "upg_cargo_1").ok).toBe(true);
    expect(installUpgradeFromMarket(world, ship, "upg_cargo_2").ok).toBe(true);

    expect(ship.upgrades?.cargo).toBe("upg_cargo_2");
    expect(ship.capacity).toBe((ship.baseCapacity ?? 60) + 35);
    expect(ship.cargo).toContainEqual(expect.objectContaining({ good: "upg_cargo_1", qty: 1 }));
  });

  it("removes an installed module back into cargo", () => {
    const world = createWorld();
    const ship = playerShip(world);
    ship.funds = 100_000;
    world.markets.haven.stock.upg_engine_1 = 1;
    world.markets.haven.prices.upg_engine_1 = 10_000;

    expect(installUpgradeFromMarket(world, ship, "upg_engine_1").ok).toBe(true);
    const upgradedSpeed = ship.speed;
    const result = removeInstalledUpgrade(world, ship, "engine");

    expect(result.ok).toBe(true);
    expect(ship.upgrades?.engine).toBeUndefined();
    expect(ship.speed).toBeLessThan(upgradedSpeed);
    expect(ship.cargo).toContainEqual(expect.objectContaining({ good: "upg_engine_1", qty: 1 }));
  });

  it("stacks upgrade modifiers with crew modifiers", () => {
    const world = createWorld();
    const ship = playerShip(world);
    ship.funds = 100_000;
    ship.crew = {
      mechanic: {
        id: "test_mechanic",
        role: "mechanic",
        name: "Test Mechanic",
        tier: 1,
        hireCost: 0,
        wagePerTick: 0,
        modifiers: { cargoCapacityBonus: 5 },
      },
    };
    recomputeShipStats(ship);
    world.markets.haven.stock.upg_cargo_1 = 1;
    world.markets.haven.prices.upg_cargo_1 = 8_000;

    expect(installUpgradeFromMarket(world, ship, "upg_cargo_1").ok).toBe(true);

    expect(ship.capacity).toBe((ship.baseCapacity ?? 60) + 20);
  });

  it("blocks cargo-hold downgrades that would overfill the resulting bay", () => {
    const world = createWorld();
    const ship = playerShip(world);
    ship.funds = 1_000_000;
    world.markets.haven.stock.upg_cargo_3 = 1;
    world.markets.haven.stock.upg_cargo_1 = 1;
    world.markets.haven.prices.upg_cargo_3 = 64_000;
    world.markets.haven.prices.upg_cargo_1 = 8_000;

    expect(installUpgradeFromMarket(world, ship, "upg_cargo_3").ok).toBe(true);
    expect(buyAtLocation(world, ship, "protein", 100).ok).toBe(true);

    const result = installUpgradeFromMarket(world, ship, "upg_cargo_1");

    expect(result.ok).toBe(false);
    expect(ship.upgrades?.cargo).toBe("upg_cargo_3");
    expect(ship.capacity).toBe((ship.baseCapacity ?? 60) + 60);
    expect(world.markets.haven.stock.upg_cargo_1).toBe(1);
  });

  it("blocks removing cargo modules that would overfill the resulting bay", () => {
    const world = createWorld();
    const ship = playerShip(world);
    ship.funds = 1_000_000;
    world.markets.haven.stock.upg_cargo_3 = 1;
    world.markets.haven.prices.upg_cargo_3 = 64_000;

    expect(installUpgradeFromMarket(world, ship, "upg_cargo_3").ok).toBe(true);
    expect(buyAtLocation(world, ship, "protein", 100).ok).toBe(true);

    const result = removeInstalledUpgrade(world, ship, "cargo");

    expect(result.ok).toBe(false);
    expect(ship.upgrades?.cargo).toBe("upg_cargo_3");
    expect(ship.capacity).toBe((ship.baseCapacity ?? 60) + 60);
    expect(ship.cargo.some(l => l.good === "upg_cargo_3")).toBe(false);
  });

  it("rapid cargo lift cuts unload time in half", () => {
    const world = createWorld();
    const ship = playerShip(world);
    ship.funds = 100_000;
    world.markets.haven.stock.upg_cargo_loader_2 = 1;
    world.markets.haven.prices.upg_cargo_loader_2 = 42_000;
    expect(installUpgradeFromMarket(world, ship, "upg_cargo_loader_2").ok).toBe(true);

    ship.cargo.push({ good: "protein", qty: 4, source: "haven", unitPrice: 1, purchasedAt: world.tick });
    const result = sellAtLocation(world, ship, "protein");

    expect(result.ok).toBe(true);
    expect(ship.unloadingCargo?.[0]?.unloadTicksRemaining).toBe(2);
    tickN(world, 2);
    expect(ship.unloadingCargo ?? []).toEqual([]);
  });

  it("zero-g unload matrix settles cargo immediately", () => {
    const world = createWorld();
    const ship = playerShip(world);
    ship.funds = 200_000;
    world.markets.haven.stock.upg_cargo_loader_3 = 1;
    world.markets.haven.prices.upg_cargo_loader_3 = 110_000;
    expect(installUpgradeFromMarket(world, ship, "upg_cargo_loader_3").ok).toBe(true);

    const fundsBefore = ship.funds;
    ship.cargo.push({ good: "protein", qty: 4, source: "haven", unitPrice: 1, purchasedAt: world.tick });
    const result = sellAtLocation(world, ship, "protein");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.some(e => e.kind === "sell" && e.good === "protein")).toBe(true);
    expect(ship.cargo).toEqual([]);
    expect(ship.unloadingCargo).toBeUndefined();
    expect(ship.funds).toBeGreaterThan(fundsBefore);
  });

  it("FTL engine plus zero-point core travels instantly without fuel", () => {
    const world = createWorld();
    const ship = playerShip(world);
    ship.funds = 300_000;
    world.markets.haven.stock.upg_engine_3 = 1;
    world.markets.haven.stock.upg_fuel_3 = 1;
    world.markets.haven.prices.upg_engine_3 = 95_000;
    world.markets.haven.prices.upg_fuel_3 = 90_000;

    expect(installUpgradeFromMarket(world, ship, "upg_engine_3").ok).toBe(true);
    expect(installUpgradeFromMarket(world, ship, "upg_fuel_3").ok).toBe(true);
    ship.currentFuel = { good: "plasma", qty: 0 };

    const result = travelTo(world, ship, "ironhold");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events.map(e => e.kind)).toEqual(["depart", "arrive"]);
    expect(ship.location).toBe("ironhold");
    expect(ship.state).toBe("idle");
    expect(ship.currentFuel?.qty).toBe(0);
  });

  // ----- phase B effect wiring ---------------------------------------------

  // Helper: install an upgrade onto the ship without spending funds. The
  // catalog quote for upgrade goods is the basePrice (`marketQuote` short-
  // circuits prices for upgrade goods), so we set funds AFTER the install
  // to keep the per-test math tidy.
  function installFreshUpgrade(world: ReturnType<typeof createWorld>, ship: ReturnType<typeof playerShip>, goodId: string) {
    const haven = world.markets.haven;
    haven.stock[goodId] = 1;
    ship.funds = 1_000_000;
    const res = installUpgradeFromMarket(world, ship, goodId);
    expect(res.ok).toBe(true);
  }

  it("buyDiscount cuts the buy price the trader pays", () => {
    const world = createWorld();
    const ship = playerShip(world);
    installFreshUpgrade(world, ship, "upg_systems_haggler_2");

    world.markets.haven.stock.parts = 100;
    world.markets.haven.prices.parts = 100;
    ship.funds = 200_000;
    const fundsBefore = ship.funds;
    expect(buyAtLocation(world, ship, "parts", 10).ok).toBe(true);
    // 10 units × 100 base × 0.96 = 960 (4% discount).
    expect(fundsBefore - ship.funds).toBeCloseTo(960, 1);
  });

  it("sellPremium pays out more than a no-premium control", () => {
    const setup = (installPremium: boolean) => {
      const world = createWorld();
      const ship = playerShip(world);
      if (installPremium) installFreshUpgrade(world, ship, "upg_systems_haggler_2");
      // Identical market state in both runs.
      ship.funds = 0;
      ship.cargo.push({ good: "parts", qty: 10, purchasedAt: 0, costBasis: 0, originLocation: "haven" });
      world.markets.haven.prices.parts = 100;
      world.markets.haven.treasury = 5_000_000;
      world.markets.haven.stock.parts = 0;
      sellAtLocation(world, ship, "parts");
      tickN(world, UNLOAD_TICKS + 2);
      return ship.funds;
    };
    const withPremium = setup(true);
    const baseline = setup(false);
    expect(withPremium).toBeGreaterThan(baseline);
    // Roughly 4% bump (premium acts on the unitPrice into settleSale).
    expect(withPremium / baseline).toBeGreaterThan(1.03);
  });

  it("dockingDiscount reduces the docking fee charged on arrival", () => {
    const world = createWorld();
    const ship = playerShip(world);
    installFreshUpgrade(world, ship, "upg_systems_dock_2");
    ship.funds = 200_000;

    const fundsBefore = ship.funds;
    chargeDockingFee(world, ship);
    const charged = fundsBefore - ship.funds;
    // 30% off — should be 70% of capacity × DOCKING_FEE_PER_CAPACITY (5).
    const baseFee = ship.capacity * 5;
    expect(charged).toBeCloseTo(baseFee * 0.7, 1);
  });

  it("contractRewardBonus pads the reward credited on job delivery", async () => {
    const { creditJobOnDelivery } = await import("./jobs");
    const world = createWorld();
    const ship = playerShip(world);
    installFreshUpgrade(world, ship, "upg_systems_haggler_1");
    ship.funds = 0;

    // Plant a single-unit shortage job at haven matching `parts`.
    world.jobs["j_test"] = {
      id: "j_test",
      kind: "shortage",
      tier: "low",
      good: "parts",
      qty: 1,
      destination: "haven",
      reward: 1_000,
      penalty: 0,
      postedTick: 0,
      expiresAt: 1_000_000,
      acceptedBy: ship.id,
      delivered: 0,
    };

    creditJobOnDelivery(world, ship.id, "haven", "parts", 1);
    // 5% bonus → 1050.
    expect(ship.funds).toBeCloseTo(1_050, 1);
  });

  it("dividendBonus pads long-position dividend payouts", async () => {
    const { payoutDividends } = await import("./stock");
    const world = createWorld();
    const ship = playerShip(world);
    installFreshUpgrade(world, ship, "upg_systems_dividend_3");
    ship.funds = 0;

    if (!world.player) throw new Error("player missing");
    const eq = Object.values(world.equities).find(e => e.kind === "station")!;
    world.player.positions = world.player.positions ?? {};
    world.player.positions[eq.id] = {
      equityId: eq.id,
      kind: "long",
      shares: 100,
      avgEntryPrice: 10,
      openedAt: 0,
    };

    // Force a treasury surplus and align the world tick to a dividend
    // interval so payoutDividends actually fires.
    const market = world.markets[eq.underlyingId];
    market.treasury = market.treasuryTarget * 10;
    // DIVIDEND_INTERVAL is private; tick to a non-zero multiple by ticking
    // the world enough that one interval has elapsed. payoutDividends
    // returns when (tick % interval) !== 0; we manually call it after
    // setting the tick to a known multiple.
    // DIVIDEND_INTERVAL is 200; only multiples of 200 fire a payout.
    world.tick = 400;
    payoutDividends(world);

    const earned = ship.funds;
    expect(earned).toBeGreaterThan(0);
    // Compute base payout from the recorded perShare and compare ratio.
    const basePayout = (eq.lastDividend?.perShare ?? 0) * 100;
    expect(basePayout).toBeGreaterThan(0);
    expect(earned / basePayout).toBeCloseTo(1.12, 1);
  });

  it("fuelRegenIdle tops up an idle ship's tank each tick", () => {
    const world = createWorld();
    const ship = playerShip(world);
    installFreshUpgrade(world, ship, "upg_fuel_regen_2");

    ship.currentFuel = { good: "plasma", qty: 10 };
    applyIdlePerks(world);
    expect(ship.currentFuel.qty).toBeCloseTo(10.5, 5);
    applyIdlePerks(world);
    expect(ship.currentFuel.qty).toBeCloseTo(11, 5);
    // Capacity-clamped: filling above the tank ceiling stays at capacity.
    ship.currentFuel.qty = ship.fuelCapacity;
    applyIdlePerks(world);
    expect(ship.currentFuel.qty).toBe(ship.fuelCapacity);
  });

  it("treasuryYield credits a small per-tick interest from the dock's treasury", () => {
    const world = createWorld();
    const ship = playerShip(world);
    installFreshUpgrade(world, ship, "upg_systems_treasury_2");
    ship.funds = 100_000;

    world.markets.haven.treasury = 10_000_000;
    const fundsBefore = ship.funds;
    applyIdlePerks(world);
    // 0.0008 × 100,000 = 80 credits.
    expect(ship.funds - fundsBefore).toBeCloseTo(80, 1);
  });
});
