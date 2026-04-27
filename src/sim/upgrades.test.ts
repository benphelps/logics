import { describe, expect, it } from "vitest";
import { recomputeShipStats } from "./crew";
import { buyAtLocation, installUpgradeFromCargo, installUpgradeFromMarket, sellAtLocation } from "./traders";
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
});
