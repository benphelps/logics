import { useStore } from "../store";
import { listTradeOptions, type TradeOption } from "../../sim/traders";
import { reachableNeighbors } from "../../sim/geometry";
import type { LocationDef, Trader, World } from "../../sim/types";
import "./PlayerView.css";

const SUGGESTION_LIMIT = 6;

export function PlayerView() {
  const world = useStore((s) => s.world);
  useStore((s) => s.tickEpoch);
  const lastError = useStore((s) => s.lastError);
  const clearError = useStore((s) => s.clearError);

  const player = world.player;
  if (!player) {
    return (
      <section>
        <h2>My Fleet</h2>
        <p className="dim">No player exists in this world.</p>
      </section>
    );
  }

  const ships = player.shipIds.map((id) => world.traders[id]).filter(Boolean);

  return (
    <section className="player-view">
      {lastError && (
        <div className="player-error" onClick={clearError}>
          <span className="bad">⚠</span> {lastError} <span className="faint">(click to dismiss)</span>
        </div>
      )}

      {ships.map((ship) => (
        <ShipPanel key={ship.id} ship={ship} world={world} />
      ))}
    </section>
  );
}

function ShipPanel({ ship, world }: { ship: Trader; world: World }) {
  const setPilot = useStore((s) => s.setPilot);
  const fuel = ship.currentFuel;
  const fuelPct = fuel ? (fuel.qty / ship.fuelCapacity) * 100 : 0;
  const fuelTone = fuelPct < 25 ? "bad" : fuelPct < 50 ? "warn" : "";

  const inTransit = ship.state === "transit";
  const loc = world.locations[ship.location];

  return (
    <article className="ship-panel">
      <header className="ship-header">
        <div>
          <h3>{ship.name} <span className="faint mono">· {inTransit ? `→ ${world.locations[ship.destination!]?.name} (${ship.ticksRemaining}t)` : `at ${loc?.name}`}</span></h3>
          <div className="ship-meta dim">
            cap {ship.capacity} · speed {ship.speed} · uses {ship.fuelTypes.map(f => f.good).join(" / ")}
          </div>
        </div>
        <div className="ship-pilot">
          <button
            className={ship.pilot === "manual" ? "primary" : ""}
            onClick={() => setPilot(ship.id, "manual")}
          >
            Manual
          </button>
          <button
            className={ship.pilot === "auto" ? "primary" : ""}
            onClick={() => setPilot(ship.id, "auto")}
            title="Auto-pilot (planned: hire crew, ship runs arbitrage on its own)"
          >
            Auto
          </button>
        </div>
      </header>

      <div className="ship-status mono">
        <span><span className="dim">cargo:</span> {ship.cargo
          ? <><span className="good">{ship.cargo.good}×{ship.cargo.qty.toFixed(0)}</span></>
          : <span className="faint">empty</span>}</span>
        <span className="dim">·</span>
        <span><span className="dim">fuel:</span> <span className={fuelTone}>{fuel?.good} {fuel?.qty.toFixed(0)}/{ship.fuelCapacity}</span></span>
        <span className="dim">·</span>
        <span><span className="dim">wallet:</span> Ç{Math.round(ship.funds).toLocaleString()}</span>
      </div>

      {inTransit ? (
        <TransitView ship={ship} world={world} />
      ) : (
        <DockedView ship={ship} world={world} loc={loc!} />
      )}
    </article>
  );
}

function TransitView({ ship, world }: { ship: Trader; world: World }) {
  const dst = world.locations[ship.destination!];
  return (
    <div className="transit-view">
      <div className="transit-banner">
        <div>
          <div className="transit-label dim">In transit to</div>
          <div className="transit-name">{dst?.name}</div>
        </div>
        <div>
          <div className="transit-label dim">Arrives in</div>
          <div className="transit-name mono">{ship.ticksRemaining}t</div>
        </div>
        {ship.cargo && (
          <div>
            <div className="transit-label dim">Carrying</div>
            <div className="transit-name mono">{ship.cargo.good} × {ship.cargo.qty.toFixed(0)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function DockedView({ ship, world, loc }: { ship: Trader; world: World; loc: LocationDef }) {
  return (
    <div className="docked-view">
      <LocationOverview loc={loc} />
      <div className="docked-grid">
        <MarketSection ship={ship} world={world} loc={loc} />
        <SidePanels ship={ship} world={world} loc={loc} />
      </div>
      <SuggestionsSection ship={ship} world={world} />
    </div>
  );
}

function LocationOverview({ loc }: { loc: LocationDef }) {
  return (
    <div className="loc-overview">
      <div className="loc-overview-title">
        <span className="loc-name">{loc.name}</span>
        {loc.traits.faction && <span className="loc-tag">{loc.traits.faction}</span>}
        {loc.traits.tags.map(t => (
          <span key={t} className="loc-tag">{t}</span>
        ))}
      </div>
      <div className="loc-overview-meta dim mono">
        tech {loc.traits.techLevel} · pop {loc.population.toLocaleString()}
        {loc.primaryExports.length > 0 && <> · exports: {loc.primaryExports.join(", ")}</>}
      </div>
    </div>
  );
}

function MarketSection({ ship, world, loc }: { ship: Trader; world: World; loc: LocationDef }) {
  const buy = useStore((s) => s.buy);
  const sell = useStore((s) => s.sell);
  const market = world.markets[loc.id];

  const goodsOrdered = Object.keys(world.goods);

  return (
    <div className="market-panel">
      <h4>Market</h4>
      <table className="market-table">
        <thead>
          <tr>
            <th>Good</th>
            <th className="numeric">Stock</th>
            <th className="numeric">Price</th>
            <th className="numeric">Net Sell*</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          {goodsOrdered.map((gid) => {
            const stock = market.stock[gid] ?? 0;
            const price = market.prices[gid] ?? 0;
            const netSell = price * (1 - 0.15); // SALES_TAX_RATE; rendered for clarity
            const isCargo = ship.cargo?.good === gid;
            const cargoQty = isCargo ? ship.cargo!.qty : 0;
            const isFuel = ship.fuelTypes.some(f => f.good === gid);

            return (
              <tr key={gid} className={isCargo ? "row-mine" : ""}>
                <td>
                  <span>{gid}</span>
                  {isCargo && <span className="dim mono"> · holding {cargoQty.toFixed(0)}</span>}
                  {isFuel && <span className="faint"> · fuel</span>}
                </td>
                <td className="numeric mono">{stock.toFixed(0)}</td>
                <td className="numeric mono">Ç{price.toFixed(1)}</td>
                <td className="numeric mono dim">Ç{netSell.toFixed(1)}</td>
                <td>
                  <BuySellControls
                    ship={ship}
                    world={world}
                    goodId={gid}
                    stock={stock}
                    price={price}
                    cargoQty={cargoQty}
                    onBuy={(qty) => buy(ship.id, gid, qty)}
                    onSell={(qty) => sell(ship.id, qty)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="market-footnote faint">
        * Net Sell = listed price minus 15% port tax. What you'd actually receive if you sold here.
      </div>
    </div>
  );
}

function BuySellControls({
  ship, world, goodId, stock, price, cargoQty, onBuy, onSell,
}: {
  ship: Trader; world: World; goodId: string; stock: number; price: number; cargoQty: number;
  onBuy: (qty: number) => void; onSell: (qty: number) => void;
}) {
  const good = world.goods[goodId];
  const cargoMass = ship.cargo ? ship.cargo.qty * world.goods[ship.cargo.good].weight : 0;
  const roomMass = ship.capacity - cargoMass;
  const maxByRoom = Math.floor(roomMass / good.weight);
  const maxByFunds = price > 0 ? Math.floor(ship.funds / price) : 0;
  const maxBuy = Math.max(0, Math.min(maxByRoom, maxByFunds, Math.floor(stock)));
  const cannotBuy = ship.cargo && ship.cargo.good !== goodId;
  const isCargoMatch = ship.cargo?.good === goodId;

  if (cannotBuy && !isCargoMatch) {
    return <span className="faint">other cargo loaded</span>;
  }

  return (
    <div className="buy-sell">
      {maxBuy > 0 && (
        <>
          <button onClick={() => onBuy(Math.min(10, maxBuy))} disabled={maxBuy < 1}>+10</button>
          <button onClick={() => onBuy(maxBuy)} className="primary" disabled={maxBuy < 1}>Buy max ({maxBuy})</button>
        </>
      )}
      {isCargoMatch && cargoQty > 0 && (
        <button onClick={() => onSell(cargoQty)}>Sell {cargoQty.toFixed(0)}</button>
      )}
      {maxBuy === 0 && !isCargoMatch && (
        <span className="faint">{stock < 1 ? "out of stock" : maxByFunds < 1 ? "can't afford" : "no room"}</span>
      )}
    </div>
  );
}

function SidePanels({ ship, world, loc }: { ship: Trader; world: World; loc: LocationDef }) {
  return (
    <div className="side-panels">
      <FuelStation ship={ship} world={world} loc={loc} />
      <TravelOptions ship={ship} world={world} />
    </div>
  );
}

function FuelStation({ ship, world, loc }: { ship: Trader; world: World; loc: LocationDef }) {
  const refuel = useStore((s) => s.refuel);
  const market = world.markets[loc.id];
  const types = ship.fuelTypes.map(ft => ({
    good: ft.good,
    perDistance: ft.perDistance,
    stock: market.stock[ft.good] ?? 0,
    price: market.prices[ft.good] ?? 0,
  }));
  const tankFraction = ship.currentFuel ? (ship.currentFuel.qty / ship.fuelCapacity) * 100 : 0;

  return (
    <div className="side-panel">
      <h4>Fuel Station</h4>
      <div className="fuel-status mono">
        <span className="dim">tank:</span>{" "}
        <span>{ship.currentFuel?.good ?? "—"}</span>{" "}
        <span>{ship.currentFuel?.qty.toFixed(0)}/{ship.fuelCapacity}</span>{" "}
        <span className="dim">({tankFraction.toFixed(0)}%)</span>
      </div>
      <ul className="fuel-list">
        {types.map((t) => (
          <li key={t.good}>
            <div>
              <span>{t.good}</span>
              <span className="faint"> · {t.perDistance.toFixed(1)}/dist</span>
            </div>
            <div className="mono">
              {t.stock > 0
                ? <><span>{t.stock.toFixed(0)} @ Ç{t.price.toFixed(1)}</span></>
                : <span className="faint">unavailable</span>}
            </div>
          </li>
        ))}
      </ul>
      <button onClick={() => refuel(ship.id)} className="primary fuel-btn">Fill tank</button>
    </div>
  );
}

function TravelOptions({ ship, world }: { ship: Trader; world: World }) {
  const travel = useStore((s) => s.travel);
  const ft = ship.fuelTypes.find(f => f.good === ship.currentFuel?.good);
  const fuel = ship.currentFuel?.qty ?? 0;
  const market = world.markets[ship.location];

  const dests = reachableNeighbors(world, ship.location)
    .map(({ to, dist }) => {
      const dst = world.locations[to];
      const fuelNeeded = ft ? dist * ft.perDistance : 0;
      const fuelCost = ft ? fuelNeeded * (market.prices[ft.good] ?? 0) : 0;
      const travelTicks = Math.max(1, Math.ceil(dist / ship.speed));
      const canFly = ft != null && fuel >= fuelNeeded;
      return { to, name: dst?.name ?? to, dist, fuelNeeded, fuelCost, travelTicks, canFly };
    })
    .sort((a, b) => a.dist - b.dist);

  return (
    <div className="side-panel">
      <h4>Travel</h4>
      <table className="travel-table">
        <thead>
          <tr>
            <th>To</th>
            <th className="numeric">Dist</th>
            <th className="numeric">Fuel</th>
            <th className="numeric">Time</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {dests.map((d) => (
            <tr key={d.to}>
              <td>{d.name}</td>
              <td className="numeric mono">{d.dist.toFixed(1)}</td>
              <td className={`numeric mono ${d.canFly ? "" : "bad"}`}>{d.fuelNeeded.toFixed(1)}</td>
              <td className="numeric mono">{d.travelTicks}t</td>
              <td>
                <button onClick={() => travel(ship.id, d.to)} disabled={!d.canFly}>Depart</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SuggestionsSection({ ship, world }: { ship: Trader; world: World }) {
  const executeOption = useStore((s) => s.executeOption);
  const suggestions: TradeOption[] = listTradeOptions(world, ship).slice(0, SUGGESTION_LIMIT);

  if (suggestions.length === 0) {
    return (
      <div className="suggestions-empty dim">
        No profitable arbitrage from {world.locations[ship.location]?.name} right now. Wait for prices to shift, or move on speculation.
      </div>
    );
  }

  return (
    <div className="suggestions">
      <h4>Suggested Trades <span className="faint">(buy + auto-depart, profit after all fees)</span></h4>
      <table className="suggestions-table">
        <thead>
          <tr>
            <th>Buy</th>
            <th>Sell at</th>
            <th className="numeric">Qty</th>
            <th className="numeric">Net Profit</th>
            <th className="numeric">Per/t</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {suggestions.map((opt, idx) => (
            <tr key={idx}>
              <td><span className="mono">{opt.good}</span> <span className="dim">@ Ç{opt.buyPrice.toFixed(1)}</span></td>
              <td>{world.locations[opt.to]?.name ?? opt.to}</td>
              <td className="numeric mono">{opt.qty}</td>
              <td className="numeric mono good">Ç{Math.round(opt.totalProfit).toLocaleString()}</td>
              <td className="numeric mono good">Ç{opt.profitPerTick.toFixed(1)}</td>
              <td><button onClick={() => executeOption(ship.id, opt)}>Execute</button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
