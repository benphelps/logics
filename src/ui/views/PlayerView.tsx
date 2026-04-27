import { useStore } from "../store";
import { listTradeOptions, type TradeOption } from "../../sim/traders";
import type { Trader, World } from "../../sim/types";
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
        <h2>Player</h2>
        <p className="dim">No player exists in this world.</p>
      </section>
    );
  }

  const ships = player.shipIds.map((id) => world.traders[id]).filter(Boolean);

  return (
    <section className="player-view">
      <h2>Player</h2>

      {lastError && (
        <div className="player-error" onClick={clearError}>
          <span className="bad">⚠</span> {lastError} <span className="faint">(click to dismiss)</span>
        </div>
      )}

      <div className="player-summary">
        <div className="player-stat">
          <div className="player-stat-label dim">Bank</div>
          <div className="player-stat-value mono">Ç{Math.round(player.funds).toLocaleString()}</div>
        </div>
        <div className="player-stat">
          <div className="player-stat-label dim">Owned Ships</div>
          <div className="player-stat-value mono">{ships.length}</div>
        </div>
        <div className="player-stat">
          <div className="player-stat-label dim">Fleet Wallet</div>
          <div className="player-stat-value mono">
            Ç{Math.round(ships.reduce((s, t) => s + t.funds, 0)).toLocaleString()}
          </div>
        </div>
      </div>

      <div className="player-ships">
        {ships.map((ship) => (
          <ShipPanel key={ship.id} ship={ship} world={world} />
        ))}
      </div>
    </section>
  );
}

function ShipPanel({ ship, world }: { ship: Trader; world: World }) {
  const executeOption = useStore((s) => s.executeOption);
  const setPilot = useStore((s) => s.setPilot);

  const fuel = ship.currentFuel;
  const fuelPct = fuel ? (fuel.qty / ship.fuelCapacity) * 100 : 0;

  const isIdle = ship.state === "idle" && !ship.cargo;
  const suggestions: TradeOption[] = isIdle ? listTradeOptions(world, ship).slice(0, SUGGESTION_LIMIT) : [];

  return (
    <article className="ship-panel">
      <header className="ship-header">
        <div>
          <h3>{ship.name}</h3>
          <div className="ship-meta dim">
            cap {ship.capacity} · speed {ship.speed} · {ship.fuelTypes.map(f => f.good).join(" / ")}
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
            title="Hire crew (NPC arbitrage logic) — soft transition to autonomous trading"
          >
            Auto
          </button>
        </div>
      </header>

      <div className="ship-status mono">
        <span><span className="dim">at </span>{world.locations[ship.location]?.name ?? ship.location}</span>
        <span className="dim">·</span>
        <span>{ship.state}{ship.destination && ` ⮕ ${world.locations[ship.destination]?.name ?? ship.destination} (${ship.ticksRemaining}t)`}</span>
        <span className="dim">·</span>
        <span>cargo: {ship.cargo ? <><span className="dim">{ship.cargo.good}×</span>{ship.cargo.qty}</> : <span className="faint">empty</span>}</span>
        <span className="dim">·</span>
        <span>fuel: <span className={fuelPct < 25 ? "bad" : fuelPct < 50 ? "warn" : ""}>{fuel?.good}</span> {fuel?.qty.toFixed(0)}/{ship.fuelCapacity}</span>
        <span className="dim">·</span>
        <span>wallet: Ç{Math.round(ship.funds).toLocaleString()}</span>
      </div>

      {isIdle && (
        <SuggestionTable
          ship={ship}
          world={world}
          suggestions={suggestions}
          onExecute={(opt) => executeOption(ship.id, opt)}
        />
      )}

      {ship.state === "transit" && (
        <div className="ship-transit-note dim">
          In transit — arrival in {ship.ticksRemaining} ticks. Will sell {ship.cargo?.qty ?? 0} {ship.cargo?.good ?? "—"} at {world.locations[ship.destination!]?.name}.
        </div>
      )}

      {!isIdle && ship.state === "idle" && ship.cargo && (
        <div className="ship-transit-note dim">
          Idle with cargo loaded — manual sell on next tick? (not implemented yet)
        </div>
      )}
    </article>
  );
}

function SuggestionTable({
  ship,
  world,
  suggestions,
  onExecute,
}: {
  ship: Trader;
  world: World;
  suggestions: TradeOption[];
  onExecute: (opt: TradeOption) => void;
}) {
  if (suggestions.length === 0) {
    return (
      <div className="suggestions-empty dim">
        No profitable trades available from {world.locations[ship.location]?.name}. Try waiting for prices to shift, or move the ship manually.
      </div>
    );
  }
  return (
    <div className="suggestions">
      <div className="suggestions-header dim">
        <span>Top suggestions from {world.locations[ship.location]?.name}</span>
        <span className="faint">(profit/tick after fees)</span>
      </div>
      <table className="suggestions-table">
        <thead>
          <tr>
            <th>Good</th>
            <th>To</th>
            <th className="numeric">Qty</th>
            <th className="numeric">Buy</th>
            <th className="numeric">Sell*</th>
            <th className="numeric">Trip</th>
            <th className="numeric">Profit</th>
            <th className="numeric">Per/t</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {suggestions.map((opt, idx) => (
            <tr key={idx}>
              <td>{opt.good}</td>
              <td>{world.locations[opt.to]?.name ?? opt.to}</td>
              <td className="numeric mono">{opt.qty}</td>
              <td className="numeric mono">Ç{opt.buyPrice.toFixed(1)}</td>
              <td className="numeric mono">Ç{opt.sellPrice.toFixed(1)}</td>
              <td className="numeric mono">{opt.travelTicks}t</td>
              <td className="numeric mono good">Ç{Math.round(opt.totalProfit).toLocaleString()}</td>
              <td className="numeric mono good">Ç{opt.profitPerTick.toFixed(1)}</td>
              <td>
                <button onClick={() => onExecute(opt)}>Execute</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="suggestions-footnote faint">
        * Sell column is the trader's net (after-tax) take. Profit = net sale × qty − buy − fuel − trip maintenance − docking fee.
      </div>
    </div>
  );
}
