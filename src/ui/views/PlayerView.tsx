import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { reachableNeighbors } from "../../sim/geometry";
import { describeHint, getGuidedHint, hintTarget, type HintTarget } from "../../sim/suggestions";
import { SALES_TAX_RATE } from "../../sim/economy";
import { cargoMass as cargoMassFn, findCargoLot, groupCargoByGood, type CargoGroup } from "../../sim/cargo";
import type { LocationDef, Trader, World } from "../../sim/types";
import "./PlayerView.css";

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
  const inTransit = ship.state === "transit";
  const loc = world.locations[ship.location];
  const hint = getGuidedHint(world, ship);
  const target = hintTarget(hint);
  const hintText = describeHint(hint, world);
  const isCriticalHint = hint.kind === "refuel" && hint.critical;

  return (
    <article className="ship-panel">
      {inTransit ? (
        <TransitView ship={ship} world={world} />
      ) : (
        <DockedView
          ship={ship}
          world={world}
          loc={loc!}
          target={target}
          hintText={hintText}
          critical={isCriticalHint}
        />
      )}

      <Inventory ship={ship} world={world} />
    </article>
  );
}

const TOOLTIP_WIDTH = 280;
const TOOLTIP_MARGIN = 12;
const TOOLTIP_GAP = 10;

function SuggestedMarker({ tip, critical }: { tip: string; critical?: boolean }) {
  const dotRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const show = () => {
    const el = dotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = rect.left;
    if (left + TOOLTIP_WIDTH > window.innerWidth - TOOLTIP_MARGIN) {
      left = window.innerWidth - TOOLTIP_MARGIN - TOOLTIP_WIDTH;
    }
    if (left < TOOLTIP_MARGIN) left = TOOLTIP_MARGIN;
    setPos({ left, top: rect.top - TOOLTIP_GAP });
  };
  const hide = () => setPos(null);

  return (
    <span
      className={`suggested-marker ${critical ? "critical" : ""}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      tabIndex={0}
    >
      <span className="suggested-marker-dot" ref={dotRef}>✦</span>
      {pos && createPortal(
        <span
          className={`suggested-tooltip ${critical ? "critical" : ""}`}
          role="tooltip"
          style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
        >
          <span className="suggested-tooltip-label">Suggested</span>
          {tip}
        </span>,
        document.body,
      )}
    </span>
  );
}

function ActionCell({ suggested, hintText, critical, children }: {
  suggested: boolean; hintText: string; critical?: boolean; children: ReactNode;
}) {
  return (
    <span className="action-cell">
      {suggested && <SuggestedMarker tip={hintText} critical={critical} />}
      {children}
    </span>
  );
}

function Inventory({ ship, world }: { ship: Trader; world: World }) {
  const mass = cargoMassFn(ship, world);
  const capacityPct = (mass / ship.capacity) * 100;
  const groups = groupCargoByGood(ship);
  const lotsTotal = ship.cargo.length;

  return (
    <div className="inventory">
      <div className="inventory-header">
        <h4>
          Inventory <span className="dim">— {groups.length} good{groups.length === 1 ? "" : "s"}{lotsTotal !== groups.length && `, ${lotsTotal} lots`}</span>
        </h4>
        <div className="capacity-gauge mono">
          <span className="dim">cargo bay </span>
          <span>{mass.toFixed(0)}/{ship.capacity}</span>
          <span className="capacity-bar">
            <span
              className="capacity-fill"
              style={{ width: `${Math.min(100, capacityPct)}%` }}
            />
          </span>
        </div>
      </div>
      <div className="inventory-grid">
        {groups.length === 0
          ? <EmptyCargoCard capacity={ship.capacity} />
          : groups.map((g) => (
              <CargoGroupCard key={g.good} group={g} ship={ship} world={world} />
            ))}
      </div>
    </div>
  );
}

function EmptyCargoCard({ capacity }: { capacity: number }) {
  return (
    <div className="cargo-card cargo-card-empty">
      <div className="cargo-card-empty-text">
        <div className="dim">Cargo bay empty</div>
        <div className="faint mono">{capacity} units of capacity available</div>
      </div>
    </div>
  );
}

function CargoGroupCard({ group, ship, world }: { group: CargoGroup; ship: Trader; world: World }) {
  const good = world.goods[group.good];
  const ageTicks = world.tick - group.oldestPurchasedAt;

  // Sell-here P&L based on weighted-average cost basis (sums across all lots).
  const hereMarket = world.markets[ship.location];
  const herePrice = hereMarket.prices[group.good] ?? 0;
  const hereNetUnit = herePrice * (1 - SALES_TAX_RATE);
  const hereNetRevenue = group.totalQty * hereNetUnit;
  const pnl = hereNetRevenue - group.totalCost;
  const pnlPct = group.totalCost > 0 ? (pnl / group.totalCost) * 100 : 0;
  const pnlTone = pnl > 0 ? "good" : pnl < 0 ? "bad" : "dim";

  const mass = group.totalQty * good.weight;
  const massPct = (mass / ship.capacity) * 100;

  const tooltip = (
    <>
      <div className="cargo-tooltip-header">
        <span className="cargo-tooltip-name">{good.name}</span>
        <span className="cargo-tooltip-qty mono">{group.totalQty.toFixed(0)} units · {group.lots.length} lot{group.lots.length === 1 ? "" : "s"}</span>
      </div>

      <dl className="cargo-tooltip-stats">
        <Stat label="weighted avg" value={`Ç${group.weightedAvgPrice.toFixed(2)}/u`} />
        <Stat label="cost basis"   value={`Ç${Math.round(group.totalCost).toLocaleString()}`} />
        <Stat label="oldest age"   value={`${ageTicks}t`} />
        <Stat label="mass"         value={`${mass.toFixed(0)} (${massPct.toFixed(0)}%)`} />
      </dl>

      {group.lots.length > 1 && (
        <div className="cargo-tooltip-lots">
          <div className="cargo-tooltip-lots-label dim">Lots (FIFO sell order):</div>
          <table className="cargo-lots-table mono">
            <thead>
              <tr><th>qty</th><th>@ paid</th><th>from</th><th>age</th></tr>
            </thead>
            <tbody>
              {[...group.lots].sort((a, b) => a.purchasedAt - b.purchasedAt).map((lot, i) => (
                <tr key={i}>
                  <td>{lot.qty.toFixed(0)}</td>
                  <td>Ç{lot.unitPrice.toFixed(2)}</td>
                  <td>{world.locations[lot.source]?.name?.split(" ")[0] ?? lot.source}</td>
                  <td>{world.tick - lot.purchasedAt}t</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="cargo-tooltip-pnl">
        <span className="dim">at Ç{herePrice.toFixed(1)} ({(SALES_TAX_RATE * 100).toFixed(0)}% tax) → </span>
        <span className="mono">Ç{Math.round(hereNetRevenue).toLocaleString()} net</span>
      </div>
    </>
  );

  return (
    <HoverTooltip content={tooltip}>
      <article className="cargo-card">
        <div className="cargo-card-title">
          <span className="cargo-card-good">{good.name}</span>
          <span className="cargo-card-times dim mono">×</span>
          <span className="cargo-card-qty mono">{group.totalQty.toFixed(0)}</span>
          {group.lots.length > 1 && (
            <span className="cargo-card-lots dim mono">{group.lots.length}L</span>
          )}
        </div>
        <div className="cargo-card-pnl mono">
          <span className={pnlTone}>
            {pnl >= 0 ? "+" : ""}Ç{Math.round(pnl).toLocaleString()}
            <span className="dim"> ({pnl >= 0 ? "+" : ""}{pnlPct.toFixed(0)}%)</span>
          </span>
          <span className="cargo-here-hint">here</span>
        </div>
      </article>
    </HoverTooltip>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="cargo-stat">
      <dt className="dim">{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}

function HoverTooltip({ content, children }: { content: ReactNode; children: ReactNode }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const show = () => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = rect.left;
    if (left + TOOLTIP_WIDTH > window.innerWidth - TOOLTIP_MARGIN) {
      left = window.innerWidth - TOOLTIP_MARGIN - TOOLTIP_WIDTH;
    }
    if (left < TOOLTIP_MARGIN) left = TOOLTIP_MARGIN;
    setPos({ left, top: rect.top - TOOLTIP_GAP });
  };
  const hide = () => setPos(null);

  return (
    <span className="hover-tooltip-host" ref={ref} onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {pos && createPortal(
        <span
          className="cargo-tooltip"
          role="tooltip"
          style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
        >
          {content}
        </span>,
        document.body,
      )}
    </span>
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
        {ship.cargo.length > 0 && (
          <div>
            <div className="transit-label dim">Carrying</div>
            <div className="transit-name">
              {ship.cargo.length === 1
                ? <>{world.goods[ship.cargo[0].good]?.name ?? ship.cargo[0].good} <span className="mono">× {ship.cargo[0].qty.toFixed(0)}</span></>
                : <>{ship.cargo.length} lots, <span className="mono">{cargoMassFn(ship, world).toFixed(0)} mass</span></>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DockedView({ ship, world, loc, target, hintText, critical }: {
  ship: Trader; world: World; loc: LocationDef; target: HintTarget; hintText: string; critical: boolean;
}) {
  return (
    <div className="docked-view">
      <div className="bridge">
        <StationCard loc={loc} world={world} />
        <ShipCard ship={ship} world={world} />
        <TravelOptions ship={ship} world={world} target={target} hintText={hintText} />
        <FuelStation ship={ship} world={world} loc={loc} target={target} hintText={hintText} critical={critical} />
      </div>
      <MarketSection ship={ship} world={world} loc={loc} target={target} hintText={hintText} />
    </div>
  );
}

function StationCard({ loc, world }: { loc: LocationDef; world: World }) {
  // imports = goods this loc consumes more than produces
  const imports = loc.consumes
    .filter(c => {
      const p = loc.produces.find(x => x.good === c.good)?.ratePerTick ?? 0;
      return p < c.ratePerTick;
    })
    .map(c => world.goods[c.good]?.name ?? c.good);

  return (
    <section className="bridge-card station-card">
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow station-eyebrow">Station</span>
          <span className="station-name">{loc.name}</span>
        </div>
        <div className="bridge-card-meta mono dim">
          L{loc.traits.techLevel} · {loc.population >= 1000 ? `${(loc.population/1000).toFixed(1)}k` : loc.population} pop
        </div>
      </header>
      <div className="station-tags">
        {loc.traits.faction && <span className="loc-tag">{loc.traits.faction}</span>}
        {loc.traits.tags.map(t => (
          <span key={t} className="loc-tag">{t}</span>
        ))}
      </div>
      <div className="station-flows">
        {loc.primaryExports.length > 0 && (
          <div className="station-flow">
            <span className="flow-label dim">EX</span>
            <span className="flow-list">{loc.primaryExports.map(g => world.goods[g]?.name ?? g).join(", ")}</span>
          </div>
        )}
        {imports.length > 0 && (
          <div className="station-flow">
            <span className="flow-label dim">IM</span>
            <span className="flow-list">{imports.join(", ")}</span>
          </div>
        )}
      </div>
    </section>
  );
}

function ShipCard({ ship, world }: { ship: Trader; world: World }) {
  const setPilot = useStore((s) => s.setPilot);
  const fuel = ship.currentFuel;
  const fuelPct = fuel ? (fuel.qty / ship.fuelCapacity) * 100 : 0;
  const fuelTone = fuelPct < 25 ? "bad" : fuelPct < 50 ? "warn" : "";
  const mass = cargoMassFn(ship, world);
  const cargoPct = (mass / ship.capacity) * 100;

  const cargoLabel = ship.cargo.length === 0
    ? <span className="faint">empty</span>
    : ship.cargo.length === 1
      ? <span className="good">{world.goods[ship.cargo[0].good]?.name ?? ship.cargo[0].good} × {ship.cargo[0].qty.toFixed(0)}</span>
      : <span className="good">{ship.cargo.length} lots</span>;

  return (
    <section className="bridge-card ship-card">
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow ship-eyebrow">Ship</span>
          <span className="ship-name">{ship.name}</span>
          <span className="ship-spec mono dim">cap {ship.capacity} · v{ship.speed}</span>
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
      <div className="ship-vital-row">
        <Vital label="cargo" value={cargoLabel} sub={`${mass.toFixed(0)}/${ship.capacity}`} pct={cargoPct} />
        <Vital
          label="fuel"
          value={<span className={fuelTone}>{fuel ? (world.goods[fuel.good]?.name ?? fuel.good) : "—"}</span>}
          sub={fuel ? `${fuel.qty.toFixed(0)}/${ship.fuelCapacity}` : "—"}
          pct={fuelPct}
          tone={fuelTone}
        />
        <Vital label="wallet" value={<span className="mono">Ç{Math.round(ship.funds).toLocaleString()}</span>} />
      </div>
    </section>
  );
}

function Vital({ label, value, sub, pct, tone }: {
  label: string; value: React.ReactNode; sub?: string; pct?: number; tone?: string;
}) {
  return (
    <div className="vital">
      <div className="vital-label dim">{label}</div>
      <div className="vital-value">{value}</div>
      {sub && <div className="vital-sub mono dim">{sub}</div>}
      {pct != null && (
        <div className="vital-bar">
          <div className={`vital-bar-fill ${tone ?? ""}`} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
    </div>
  );
}

function MarketSection({ ship, world, loc, target, hintText }: {
  ship: Trader; world: World; loc: LocationDef; target: HintTarget; hintText: string;
}) {
  const buy = useStore((s) => s.buy);
  const sell = useStore((s) => s.sell);
  const market = world.markets[loc.id];
  const goodsOrdered = Object.keys(world.goods);

  return (
    <div className="market-panel">
      <h4>Market</h4>
      <table className="market-table">
        <colgroup>
          <col className="col-good" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-action" />
        </colgroup>
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
            const netSell = price * (1 - 0.15);
            const matchingLot = findCargoLot(ship, gid);
            const isCargo = matchingLot != null;
            const cargoQty = matchingLot?.qty ?? 0;
            const isFuel = ship.fuelTypes.some(f => f.good === gid);
            const isBuyTarget = target.buyGood === gid;
            const isSellTarget = target.sellCargo === true && isCargo;
            const rowClass = (isBuyTarget || isSellTarget) ? "row-suggested" : isCargo ? "row-mine" : "";

            return (
              <tr key={gid} className={rowClass}>
                <td>
                  <span className="good-name">{world.goods[gid].name}</span>
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
                    suggestedBuy={isBuyTarget}
                    suggestedSell={isSellTarget}
                    hintText={hintText}
                    onBuy={(qty) => buy(ship.id, gid, qty)}
                    onSell={(qty) => sell(ship.id, gid, qty)}
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
  ship, world, goodId, stock, price, cargoQty, suggestedBuy, suggestedSell, hintText, onBuy, onSell,
}: {
  ship: Trader; world: World; goodId: string; stock: number; price: number; cargoQty: number;
  suggestedBuy: boolean; suggestedSell: boolean; hintText: string;
  onBuy: (qty: number) => void; onSell: (qty: number) => void;
}) {
  const good = world.goods[goodId];
  const totalMass = cargoMassFn(ship, world);
  const roomMass = ship.capacity - totalMass;
  const maxByRoom = Math.floor(roomMass / good.weight);
  const maxByFunds = price > 0 ? Math.floor(ship.funds / price) : 0;
  const maxBuy = Math.max(0, Math.min(maxByRoom, maxByFunds, Math.floor(stock)));
  const isCargoMatch = findCargoLot(ship, goodId) != null;

  const canBuy10 = maxBuy >= 10;
  const canBuyMax = maxBuy >= 1;
  const canSell = isCargoMatch && cargoQty >= 1;

  let buyTitle = "";
  if (stock < 1) buyTitle = "Out of stock here";
  else if (maxByRoom < 1) buyTitle = "Cargo bay full";
  else if (maxByFunds < 1) buyTitle = "Insufficient funds";

  const sellTitle = !isCargoMatch ? `No ${goodId} in cargo` : "";

  return (
    <div className="buy-sell">
      <button
        className="btn-action btn-narrow"
        onClick={() => onBuy(10)}
        disabled={!canBuy10}
        title={canBuy10 ? "Buy 10" : (buyTitle || "Need room/funds/stock for at least 10")}
      >
        <span className="btn-label">+10</span>
      </button>
      <ActionCell suggested={suggestedBuy} hintText={hintText}>
        <button
          className={`btn-action ${suggestedBuy ? "btn-suggested" : "primary"}`}
          onClick={() => onBuy(maxBuy)}
          disabled={!canBuyMax}
          title={canBuyMax ? "" : buyTitle}
        >
          <span className="btn-label">Buy max</span>
          <span className="btn-count">{maxBuy}</span>
        </button>
      </ActionCell>
      <ActionCell suggested={suggestedSell} hintText={hintText}>
        <button
          className={`btn-action ${suggestedSell ? "btn-suggested" : ""}`}
          onClick={() => onSell(cargoQty)}
          disabled={!canSell}
          title={canSell ? "" : sellTitle}
        >
          <span className="btn-label">Sell</span>
          <span className="btn-count">{canSell ? cargoQty.toFixed(0) : "0"}</span>
        </button>
      </ActionCell>
    </div>
  );
}

function FuelStation({ ship, world, loc, target, hintText, critical }: {
  ship: Trader; world: World; loc: LocationDef; target: HintTarget; hintText: string; critical: boolean;
}) {
  const refuel = useStore((s) => s.refuel);
  const market = world.markets[loc.id];
  const types = ship.fuelTypes.map(ft => ({
    good: ft.good,
    perDistance: ft.perDistance,
    stock: market.stock[ft.good] ?? 0,
    price: market.prices[ft.good] ?? 0,
  }));
  const tankFraction = ship.currentFuel ? (ship.currentFuel.qty / ship.fuelCapacity) * 100 : 0;
  const suggested = target.refuel === true;
  const anyFuelAvailable = types.some(t => t.stock > 0);

  const tankFuelName = ship.currentFuel?.good ? (world.goods[ship.currentFuel.good]?.name ?? ship.currentFuel.good) : "—";

  return (
    <section className={`bridge-card fuel-card ${suggested ? "panel-suggested" : ""} ${!anyFuelAvailable ? "fuel-card-empty" : ""}`}>
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow ship-eyebrow">Fuel</span>
          <span className="fuel-tank-inline mono">
            <span className="dim">tank </span>
            <span>{tankFuelName}</span>{" "}
            <span>{ship.currentFuel?.qty.toFixed(0)}/{ship.fuelCapacity}</span>
            <span className="dim"> ({tankFraction.toFixed(0)}%)</span>
          </span>
        </div>
        {!anyFuelAvailable
          ? <span className="fuel-badge-empty">No fuel here</span>
          : (
            <ActionCell suggested={suggested} hintText={hintText} critical={critical}>
              <button
                onClick={() => refuel(ship.id)}
                className={`btn-action btn-fuel-inline ${critical ? "btn-suggested-critical" : suggested ? "btn-suggested" : "primary"}`}
              >
                <span className="btn-label">{critical ? "Refuel now" : "Fill tank"}</span>
              </button>
            </ActionCell>
          )}
      </header>
      <ul className="fuel-list">
        {types.map((t) => (
          <li key={t.good} className={t.stock > 0 ? "" : "fuel-row-empty"}>
            <span><span>{world.goods[t.good]?.name ?? t.good}</span><span className="faint"> · {t.perDistance.toFixed(1)}/d</span></span>
            <span className="mono">
              {t.stock > 0
                ? <span>{t.stock.toFixed(0)} @ Ç{t.price.toFixed(1)}</span>
                : <span className="faint">—</span>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function TravelOptions({ ship, world, target, hintText }: {
  ship: Trader; world: World; target: HintTarget; hintText: string;
}) {
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
    <section className="bridge-card travel-card">
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow station-eyebrow">Travel</span>
          <span className="dim mono">{dests.length} routes</span>
        </div>
      </header>
      <table className="travel-table">
        <colgroup>
          <col className="col-dest" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-action" />
        </colgroup>
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
          {dests.map((d) => {
            const suggested = target.travelTo === d.to;
            return (
              <tr key={d.to} className={suggested ? "row-suggested" : ""}>
                <td>{d.name}</td>
                <td className="numeric mono">{d.dist.toFixed(1)}</td>
                <td className={`numeric mono ${d.canFly ? "" : "bad"}`}>{d.fuelNeeded.toFixed(1)}</td>
                <td className="numeric mono">{d.travelTicks}t</td>
                <td>
                  <ActionCell suggested={suggested && d.canFly} hintText={hintText}>
                    <button
                      onClick={() => travel(ship.id, d.to)}
                      disabled={!d.canFly}
                      className={`btn-action ${suggested && d.canFly ? "btn-suggested" : ""}`}
                      title={d.canFly ? "" : "Insufficient fuel for this trip"}
                    >
                      <span className="btn-label">Depart</span>
                    </button>
                  </ActionCell>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
