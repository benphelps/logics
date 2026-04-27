import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useStore } from "../store";
import { distance, reachableNeighbors } from "../../sim/geometry";
import { describeHint, getGuidedHint, hintTarget, type HintTarget } from "../../sim/suggestions";
import { SALES_TAX_RATE } from "../../sim/economy";
import { cargoMass as cargoMassFn, findCargoLot, groupCargoByGood, type CargoGroup } from "../../sim/cargo";
import { listAvailableRescueJobs, listLocalJobs } from "../../sim/jobs";
import { hasCrew, totalCrewWage } from "../../sim/crew";
import { MAINTENANCE_DEBT_TRAVEL_BLOCK } from "../../sim/crew";
import { listHiresAt } from "../../sim/hires";
import type { CrewModifiers, CrewRole } from "../../sim/types";
import type { Job, LocationDef, Trader, World } from "../../sim/types";
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
  // While in transit, the "station of interest" is the destination — that's
  // where the cargo will sell, where the ship will dock, what the player
  // is steering toward. Same bridge layout, different focal station.
  const focusLoc = inTransit
    ? world.locations[ship.destination!]
    : world.locations[ship.location];
  const hint = getGuidedHint(world, ship);
  const target = hintTarget(hint);
  const hintText = describeHint(hint, world);
  const isCriticalHint = hint.kind === "refuel" && hint.critical;

  return (
    <article className="ship-panel">
      <DockedView
        ship={ship}
        world={world}
        loc={focusLoc!}
        target={target}
        hintText={hintText}
        critical={isCriticalHint}
        inTransit={inTransit}
      />
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="cargo-stat">
      <dt className="dim">{label}</dt>
      <dd className="mono">{value}</dd>
    </div>
  );
}

function useHoverTooltip<T extends HTMLElement>(content: ReactNode) {
  const ref = useRef<T>(null);
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

  const portal = pos && createPortal(
    <span
      className="cargo-tooltip"
      role="tooltip"
      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
    >
      {content}
    </span>,
    document.body,
  );

  return { ref, handlers: { onMouseEnter: show, onMouseLeave: hide }, portal };
}

function DockedView({ ship, world, loc, target, hintText, critical, inTransit }: {
  ship: Trader; world: World; loc: LocationDef; target: HintTarget; hintText: string; critical: boolean; inTransit: boolean;
}) {
  return (
    <div className="docked-view">
      <div className="bridge">
        <ShipCard ship={ship} world={world} />
        <StationCard loc={loc} world={world} inTransit={inTransit} />
        <CargoBridgeCard ship={ship} world={world} loc={loc} target={target} hintText={hintText} critical={critical} inTransit={inTransit} />
        {inTransit
          ? <TransitCard ship={ship} world={world} />
          : <TravelOptions ship={ship} world={world} target={target} hintText={hintText} />}
      </div>
      {inTransit
        ? <TransitMarketPlaceholder destName={loc.name} ticksRemaining={ship.ticksRemaining} />
        : (
          <div className="bridge-split">
            <MarketAndHireCard ship={ship} world={world} loc={loc} target={target} hintText={hintText} />
            <LocalJobsCallout ship={ship} world={world} loc={loc} target={target} hintText={hintText} />
          </div>
        )}
      <ShipLogCard ship={ship} world={world} />
    </div>
  );
}

function ShipLogCard({ ship, world }: { ship: Trader; world: World }) {
  const entries = ship.log ?? [];
  // Newest-first display so the latest action is at the top — feels like a feed.
  const ordered = [...entries].reverse();
  return (
    <section className="bridge-card ship-log-card">
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow ship-eyebrow">Log</span>
          <span className="dim mono">{ship.name}</span>
        </div>
        <span className="dim mono">{entries.length} entries</span>
      </header>
      {ordered.length === 0 ? (
        <p className="ship-log-empty dim">No actions yet. Buy, sell, refuel, travel, or accept a contract — they'll all show up here.</p>
      ) : (
        <ol className="ship-log-list">
          {ordered.map((e, i) => (
            <li key={`${e.tick}-${i}`} className={`ship-log-entry ${e.tone ? `tone-${e.tone}` : ""}`}>
              <span className="ship-log-tick mono dim">t{e.tick}</span>
              <span className="ship-log-kind">{e.kind.replace(/_/g, " ")}</span>
              <span className="ship-log-msg">{e.message}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function LocalJobsCallout({ ship, world, loc, target, hintText }: {
  ship: Trader; world: World; loc: LocationDef; target: HintTarget; hintText: string;
}) {
  const acceptJob = useStore((s) => s.acceptJob);
  // Local-station shortages + co-located rescues, plus ALL remote rescues
  // (rescues broadcast over comms so they follow the player from station to
  // station). Dedupe to avoid double-listing co-located rescues.
  const local = listLocalJobs(world, loc.id);
  const seen = new Set(local.map(j => j.id));
  const remoteRescues = listAvailableRescueJobs(world).filter(j => !seen.has(j.id));
  const jobs = [...local, ...remoteRescues].sort(localJobSort);

  return (
    <section className="bridge-card local-jobs-card">
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow station-eyebrow">Contracts</span>
        </div>
        <span className="dim mono">{jobs.length} open</span>
      </header>
      <table className="jobs-table">
        <colgroup>
          <col className="col-tier" />
          <col className="col-good" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-action" />
        </colgroup>
        <thead>
          <tr>
            <th>Tier</th>
            <th>Good</th>
            <th className="numeric">Qty</th>
            <th className="numeric">On hand</th>
            <th className="numeric">Reward</th>
            <th className="numeric">Penalty</th>
            <th className="numeric">Expires</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {jobs.length === 0 ? (
            <tr><td colSpan={8} className="jobs-row-empty">No open contracts here and no distress calls active.</td></tr>
          ) : (
            jobs.map((j) => (
              <LocalJobRow
                key={j.id}
                job={j}
                world={world}
                ship={ship}
                suggested={target.acceptJobId === j.id}
                hintText={hintText}
                onAccept={() => acceptJob(j.id, ship.id)}
              />
            ))
          )}
        </tbody>
      </table>
    </section>
  );
}

const TIER_RANK: Record<Job["tier"], number> = { high: 0, medium: 1, low: 2 };
function localJobSort(a: Job, b: Job): number {
  const t = TIER_RANK[a.tier] - TIER_RANK[b.tier];
  return t !== 0 ? t : a.expiresAt - b.expiresAt;
}

function LocalJobRow({ job, world, ship, suggested, hintText, onAccept }: {
  job: Job; world: World; ship: Trader; suggested: boolean; hintText: string; onAccept: () => void;
}) {
  const good = world.goods[job.good]?.name ?? job.good;
  const ticksLeft = Math.max(0, job.expiresAt - world.tick);
  const expiringSoon = ticksLeft <= 10;
  const onHand = ship.cargo.filter(l => l.good === job.good).reduce((s, l) => s + l.qty, 0);
  const onHandTone = onHand >= job.qty ? "good" : onHand > 0 ? "warn" : "faint";
  return (
    <tr className={`job-row tier-${job.tier} ${suggested ? "row-suggested" : ""}`}>
      <td><span className={`tier-badge tier-${job.tier}`}>{job.tier.toUpperCase()}</span></td>
      <td>
        <span className="good-name">{good}</span>
        {job.kind === "rescue" && (
          <span className="job-kind-tag" title={job.rescueTarget ? `Rescue ${world.traders[job.rescueTarget]?.name ?? job.rescueTarget}` : "Rescue contract"}>
            rescue
          </span>
        )}
        {job.destination !== ship.location && (
          <div className="job-sub dim mono">→ {world.locations[job.destination]?.name ?? job.destination}</div>
        )}
      </td>
      <td className="numeric mono">{job.qty}</td>
      <td className={`numeric mono ${onHandTone}`}>{onHand > 0 ? onHand.toFixed(0) : "—"}</td>
      <td className="numeric mono good">Ç{job.reward.toLocaleString()}</td>
      <td className="numeric mono">
        {job.penalty > 0 ? <span className="bad">−Ç{job.penalty.toLocaleString()}</span> : <span className="faint">none</span>}
      </td>
      <td className={`numeric mono ${expiringSoon ? "warn" : "dim"}`}>{ticksLeft}t</td>
      <td>
        <ActionCell suggested={suggested} hintText={hintText}>
          <button className={`btn-action ${suggested ? "btn-suggested" : "primary"}`} onClick={onAccept}>
            <span className="btn-label">Accept</span>
          </button>
        </ActionCell>
      </td>
    </tr>
  );
}

function TransitCard({ ship, world }: { ship: Trader; world: World }) {
  const stepN = useStore((s) => s.stepN);
  const dst = world.locations[ship.destination!];
  // Recover total trip ticks from origin/destination distance — same math the
  // sim used on departure (ship.location is still the ORIGIN until arrival).
  const tripDist = distance(world, ship.location, ship.destination!);
  const totalTicks = Math.max(1, Math.ceil(tripDist / ship.speed));
  const elapsed = totalTicks - ship.ticksRemaining;
  const pct = Math.max(0, Math.min(100, (elapsed / totalTicks) * 100));

  return (
    <section className="bridge-card travel-card">
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow station-eyebrow">Travel</span>
          <span className="dim mono">→ {dst?.name ?? ship.destination}</span>
        </div>
        <button
          className="btn-action btn-fuel-inline"
          onClick={() => stepN(ship.ticksRemaining)}
          title={`Advance ${ship.ticksRemaining} ticks until arrival`}
        >
          <span className="btn-label">Quick Travel</span>
        </button>
      </header>
      <div className="transit-progress">
        <div className="transit-progress-meta mono">
          <span className="dim">tick</span>
          <span>{elapsed} / {totalTicks}</span>
          <span className="transit-progress-spacer" />
          <span className="dim">remaining</span>
          <span>{ship.ticksRemaining}t</span>
        </div>
        <div className="vital-bar transit-progress-bar">
          <div className="vital-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </section>
  );
}

function TransitMarketPlaceholder({ destName, ticksRemaining }: { destName: string; ticksRemaining: number }) {
  return (
    <section className="bridge-card market-card transit-placeholder">
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow station-eyebrow">Market</span>
        </div>
      </header>
      <div className="transit-placeholder-body dim">
        No market while in transit. Arriving at {destName} in {ticksRemaining} ticks.
      </div>
    </section>
  );
}

function StationCard({ loc, world, inTransit }: { loc: LocationDef; world: World; inTransit?: boolean }) {
  // imports = goods this loc consumes more than produces
  const imports = loc.consumes
    .filter(c => {
      const p = loc.produces.find(x => x.good === c.good)?.ratePerTick ?? 0;
      return p < c.ratePerTick;
    })
    .map(c => world.goods[c.good]?.name ?? c.good);

  return (
    <section className={`bridge-card station-card ${inTransit ? "station-card-incoming" : ""}`}>
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow station-eyebrow">{inTransit ? "Approaching" : "Station"}</span>
          <span className="station-name">{loc.name}</span>
          <div className="station-tags">
            {loc.traits.faction && <span className="loc-tag">{loc.traits.faction}</span>}
            {loc.traits.tags.map(t => (
              <span key={t} className="loc-tag">{t}</span>
            ))}
          </div>
        </div>
        <div className="bridge-card-meta mono dim">
          L{loc.traits.techLevel} · {loc.population >= 1000 ? `${(loc.population/1000).toFixed(1)}k` : loc.population} pop
        </div>
      </header>
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
  const repairShip = useStore((s) => s.repairShip);
  const fuel = ship.currentFuel;
  const fuelPct = fuel ? (fuel.qty / ship.fuelCapacity) * 100 : 0;
  const fuelTone = fuelPct < 25 ? "bad" : fuelPct < 50 ? "warn" : "";
  const mass = cargoMassFn(ship, world);
  const cargoPct = (mass / ship.capacity) * 100;

  const cargoLabel = <span className="mono">{mass.toFixed(0)}/{ship.capacity}</span>;
  const fuelLabel = fuel ? (
    <span className={fuelTone}>
      <span className="mono">{fuel.qty.toFixed(0)}/{ship.fuelCapacity}</span>
      <span className="dim"> · {world.goods[fuel.good]?.name ?? fuel.good}</span>
    </span>
  ) : <span className="dim">—</span>;

  const captain = ship.crew?.captain;
  const navigator = ship.crew?.navigator;
  const mechanic = ship.crew?.mechanic;
  const wage = totalCrewWage(ship);
  const debt = ship.maintenanceDebt ?? 0;
  const debtTone = debt >= MAINTENANCE_DEBT_TRAVEL_BLOCK ? "bad" : debt > 0 ? "warn" : "";
  const canRepair = debt > 0 && ship.state === "idle";
  const autoBlocked = !hasCrew(ship, "captain");

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
            disabled={autoBlocked}
            title={autoBlocked ? "Hire a captain to engage auto-pilot" : "Auto-pilot (captain handles trades; navigator unlocks contracts)"}
          >
            Auto
          </button>
        </div>
      </header>
      <div className="ship-vital-row">
        <Vital label="cargo" value={cargoLabel} pct={cargoPct} />
        <Vital label="fuel" value={fuelLabel} pct={fuelPct} tone={fuelTone} />
        <Vital label="wallet" value={<span className="mono">Ç{Math.round(ship.funds).toLocaleString()}</span>} />
      </div>
      <div className="ship-crew-strip">
        <CrewSlot label="cap" member={captain} />
        <CrewSlot label="nav" member={navigator} />
        <CrewSlot label="mech" member={mechanic} />
        <span className="ship-crew-wage mono dim">Ç{wage}/t wage</span>
      </div>
      {(debt > 0 || autoBlocked) && (
        <div className="ship-status-strip">
          {debt > 0 && (
            <span className={`ship-status-item ${debtTone}`}>
              maintenance debt <span className="mono">Ç{Math.round(debt).toLocaleString()}</span>
              {debt >= MAINTENANCE_DEBT_TRAVEL_BLOCK && <span className="dim"> · ship grounded</span>}
              <button
                className="btn-action ship-status-action"
                onClick={() => repairShip(ship.id)}
                disabled={!canRepair}
                title={canRepair ? "Pay accrued maintenance" : "Dock to repair"}
              >
                <span className="btn-label">Repair Ship</span>
              </button>
            </span>
          )}
          {autoBlocked && (
            <span className="ship-status-item dim">
              hire a captain to enable auto-pilot
            </span>
          )}
        </div>
      )}
    </section>
  );
}

function CrewSlot({ label, member }: { label: string; member?: { name: string; tier: number } }) {
  return (
    <span className={`ship-crew-slot ${member ? "filled" : "vacant"}`} title={member ? `${member.name} · tier ${member.tier}` : `${label}: vacant`}>
      <span className="ship-crew-label dim">{label}</span>
      <span className="ship-crew-name">{member ? member.name.split(" ").slice(-1)[0] : "—"}</span>
    </span>
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

// Tabbed shell sitting on the left side of the bottom split: [Market | Hire offers].
// Mirrors the Cargo|Crew tab pattern used in the bridge-card above.
function MarketAndHireCard({ ship, world, loc, target, hintText }: {
  ship: Trader; world: World; loc: LocationDef; target: HintTarget; hintText: string;
}) {
  const [tab, setTab] = useState<"market" | "offers">("market");
  const offers = listHiresAt(world, ship.location);
  return (
    <section className="bridge-card market-card">
      <header className="bridge-card-head">
        <div className="bridge-card-tabs">
          <button className={`bridge-tab ${tab === "market" ? "active" : ""}`} onClick={() => setTab("market")}>
            Market
          </button>
          <button className={`bridge-tab ${tab === "offers" ? "active" : ""}`} onClick={() => setTab("offers")}>
            Hire offers <span className="bridge-tab-count">{offers.length}</span>
          </button>
        </div>
      </header>
      {tab === "market"
        ? <MarketTableBody ship={ship} world={world} loc={loc} target={target} hintText={hintText} />
        : <HireOffersTab ship={ship} world={world} />}
    </section>
  );
}

function MarketTableBody({ ship, world, loc, target, hintText }: {
  ship: Trader; world: World; loc: LocationDef; target: HintTarget; hintText: string;
}) {
  const buy = useStore((s) => s.buy);
  const sell = useStore((s) => s.sell);
  const market = world.markets[loc.id];
  const goodsOrdered = Object.keys(world.goods);

  return (
    <>
      <table className="market-table">
        <colgroup>
          <col className="col-good" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-net-sell" />
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
    </>
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

function CargoBridgeCard({ ship, world, loc, target, hintText, critical, inTransit }: {
  ship: Trader; world: World; loc: LocationDef; target: HintTarget; hintText: string; critical: boolean; inTransit: boolean;
}) {
  const refuel = useStore((s) => s.refuel);
  const [tab, setTab] = useState<"cargo" | "crew" | "active">("cargo");
  // Player ships only — accepted contracts attached to this ship.
  const activeJobs = Object.values(world.jobs).filter(j => j.acceptedBy === ship.id);
  // When in transit, "loc" is the destination — use that market for the
  // P&L preview so the player sees what their cargo will be worth on arrival.
  // When docked, loc IS the current location, same as before.
  const refMarket = world.markets[loc.id];
  const fuelTypes = inTransit ? [] : ship.fuelTypes.map(ft => ({
    good: ft.good,
    perDistance: ft.perDistance,
    stock: refMarket.stock[ft.good] ?? 0,
    price: refMarket.prices[ft.good] ?? 0,
  }));
  const suggested = target.refuel === true && !inTransit;
  const anyFuelAvailable = !inTransit && fuelTypes.some(t => t.stock > 0);
  const groups = groupCargoByGood(ship);

  // The Fill tank / refuel CTA stays in the header regardless of which tab
  // is active — fuel state is universal context, not cargo-specific.
  const headerAction = inTransit
    ? <span className="fuel-badge-empty fuel-badge-transit">In transit</span>
    : !anyFuelAvailable
      ? <span className="fuel-badge-empty">No fuel here</span>
      : (
        <ActionCell suggested={suggested} hintText={hintText} critical={critical}>
          <button
            onClick={() => refuel(ship.id)}
            className={`btn-action btn-fuel-inline ${critical ? "btn-suggested-critical" : suggested ? "btn-suggested" : "primary"}`}
          >
            <span className="btn-label">{critical ? "Refuel" : "Fill tank"}</span>
          </button>
        </ActionCell>
      );

  return (
    <section className={`bridge-card cargo-bridge-card ${suggested ? "panel-suggested" : ""}`}>
      <header className="bridge-card-head">
        <div className="bridge-card-tabs">
          <button
            className={`bridge-tab ${tab === "cargo" ? "active" : ""}`}
            onClick={() => setTab("cargo")}
          >
            Cargo {ship.cargo.length > 0 && <span className="bridge-tab-count">{ship.cargo.length}</span>}
          </button>
          <button
            className={`bridge-tab ${tab === "crew" ? "active" : ""}`}
            onClick={() => setTab("crew")}
          >
            Crew <span className="bridge-tab-count">{Object.keys(ship.crew ?? {}).length}/3</span>
          </button>
          <button
            className={`bridge-tab ${tab === "active" ? "active" : ""}`}
            onClick={() => setTab("active")}
          >
            Contracts {activeJobs.length > 0 && <span className="bridge-tab-count">{activeJobs.length}</span>}
          </button>
        </div>
        {headerAction}
      </header>
      {tab === "cargo" && <CargoTab ship={ship} world={world} loc={loc} groups={groups} inTransit={inTransit} />}
      {tab === "crew" && <CrewTab ship={ship} />}
      {tab === "active" && <ActiveContractsTab ship={ship} world={world} jobs={activeJobs} />}
    </section>
  );
}

function CargoTab({ ship, world, loc, groups, inTransit }: {
  ship: Trader; world: World; loc: LocationDef; groups: CargoGroup[]; inTransit: boolean;
}) {
  return (
    <table className="cargo-table">
      <colgroup>
        <col />
        <col className="col-num" />
        <col className="cargo-col-pnl" />
      </colgroup>
      <thead>
        <tr>
          <th>Good</th>
          <th className="numeric">Qty</th>
          <th className="numeric">P&amp;L <span className="dim">({inTransit ? "on arrival" : "here"})</span></th>
        </tr>
      </thead>
      <tbody>
        {groups.length === 0 ? (
          <tr><td colSpan={3} className="cargo-row-empty">Cargo bay empty</td></tr>
        ) : (
          groups.map((g) => <CargoRow key={g.good} group={g} ship={ship} world={world} refLocId={loc.id} />)
        )}
      </tbody>
    </table>
  );
}

function CargoRow({ group, ship, world, refLocId }: { group: CargoGroup; ship: Trader; world: World; refLocId: string }) {
  const good = world.goods[group.good];
  const ageTicks = world.tick - group.oldestPurchasedAt;
  const hereMarket = world.markets[refLocId];
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

  const tip = useHoverTooltip<HTMLTableRowElement>(tooltip);

  return (
    <>
      <tr className="cargo-row" ref={tip.ref} {...tip.handlers}>
        <td>
          <span className="cargo-row-name">{good.name}</span>
          {group.lots.length > 1 && <span className="cargo-row-lots dim mono"> ({group.lots.length}L)</span>}
        </td>
        <td className="numeric mono">{group.totalQty.toFixed(0)}</td>
        <td className={`numeric mono cargo-row-pnl ${pnlTone}`}>
          {pnl >= 0 ? "+" : ""}Ç{Math.round(pnl).toLocaleString()}
          <span className="dim"> ({pnl >= 0 ? "+" : ""}{pnlPct.toFixed(0)}%)</span>
        </td>
      </tr>
      {tip.portal}
    </>
  );
}

const MOD_LABEL: Record<keyof CrewModifiers, (v: number) => string> = {
  cargoCapacityBonus:  (v) => `+${v} cargo`,
  fuelCapacityBonus:   (v) => `+${v} fuel`,
  speedBonus:          (v) => `+${v} speed`,
  rangeEfficiency:     (v) => `−${(v * 100).toFixed(0)}% fuel/dist`,
  buyDiscount:         (v) => `−${(v * 100).toFixed(0)}% buy`,
  sellPremium:         (v) => `+${(v * 100).toFixed(0)}% sell`,
  maintenanceDiscount: (v) => `−${(v * 100).toFixed(0)}% maint`,
  contractRewardBonus: (v) => `+${(v * 100).toFixed(0)}% contracts`,
};

function modifiersText(mods: CrewModifiers): string {
  const entries = Object.entries(mods).filter(([, v]) => v) as [keyof CrewModifiers, number][];
  return entries.map(([k, v]) => MOD_LABEL[k](v)).join(" · ");
}

// Crew tab inside the Cargo card — current crew only. Each role row shows
// who's hired (or vacant) with a Fire button. Hiring happens from the
// "Hire offers" tab next to the market.
function CrewTab({ ship }: { ship: Trader }) {
  const fire = useStore((s) => s.fireCrew);
  const docked = ship.state === "idle";
  const wage = totalCrewWage(ship);
  const roles: { role: CrewRole; label: string }[] = [
    { role: "captain",   label: "Captain" },
    { role: "navigator", label: "Navigator" },
    { role: "mechanic",  label: "Mechanic" },
  ];

  return (
    <table className="crew-table">
      <colgroup>
        <col className="col-role" />
        <col />
        <col className="col-num" />
        <col className="col-action" />
      </colgroup>
      <thead>
        <tr>
          <th>Role</th>
          <th>Crew</th>
          <th className="numeric">Wage</th>
          <th className="numeric">Ç{wage}/t</th>
        </tr>
      </thead>
      <tbody>
        {roles.map(({ role, label }) => {
          const member = ship.crew?.[role];
          const mods = member ? modifiersText(member.modifiers) : "";
          return (
            <tr key={role} className="crew-row">
              <td className="dim">{label}</td>
              <td>
                {member ? (
                  <>
                    <span className="crew-name">{member.name}</span>
                    <span className="crew-tier mono"> {"★".repeat(member.tier)}</span>
                    {mods && <span className="crew-mods dim" title={mods}> · {mods}</span>}
                  </>
                ) : (
                  <span className="faint">vacant — hire from Offers tab</span>
                )}
              </td>
              <td className="numeric mono dim">{member ? `Ç${member.wagePerTick}/t` : "—"}</td>
              <td>
                {member && (
                  <button
                    className="btn-action"
                    onClick={() => fire(ship.id, role)}
                    disabled={!docked}
                    title={docked ? "Stop wages. No refund." : "Dock to fire"}
                  >
                    <span className="btn-label">Fire</span>
                  </button>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Accepted-contract list for this ship — lives in the Cargo|Crew|Active tab
// strip rather than in the Jobs sidebar tab. Per-ship view lets the player
// see at-a-glance what their currently-focused ship is committed to.
function ActiveContractsTab({ ship, world, jobs }: { ship: Trader; world: World; jobs: Job[] }) {
  const abandonJob = useStore((s) => s.abandonJob);
  const sorted = [...jobs].sort((a, b) => {
    const tierRank: Record<typeof a.tier, number> = { high: 0, medium: 1, low: 2 };
    return tierRank[a.tier] - tierRank[b.tier] || a.expiresAt - b.expiresAt;
  });
  return (
    <table className="jobs-table active-contracts-table">
      <colgroup>
        <col className="col-tier" />
        <col className="col-good" />
        <col className="col-progress" />
        <col className="col-num" />
        <col className="col-num" />
        <col className="col-action" />
      </colgroup>
      <thead>
        <tr>
          <th>Tier</th>
          <th>Good</th>
          <th className="numeric">Done</th>
          <th className="numeric">Reward</th>
          <th className="numeric">Exp</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 ? (
          <tr><td colSpan={6} className="jobs-row-empty">No active contracts. Accept some from the Contracts panel or auto-accept on arrival (with a navigator).</td></tr>
        ) : sorted.map((j) => {
          const ticksLeft = Math.max(0, j.expiresAt - world.tick);
          const expiringSoon = ticksLeft <= 10;
          const dst = world.locations[j.destination]?.name ?? j.destination;
          const good = world.goods[j.good]?.name ?? j.good;
          const away = j.destination !== ship.location;
          return (
            <tr key={j.id} className={`job-row tier-${j.tier} job-row-active`}>
              <td><span className={`tier-badge tier-${j.tier}`}>{j.tier.toUpperCase()}</span></td>
              <td>
                <span className="good-name">{good}</span>
                {j.kind === "rescue" && <span className="job-kind-tag">rescue</span>}
                <span className="dim mono"> → {dst}</span>
                {away && <span className="faint mono"> · away</span>}
              </td>
              <td className="numeric mono">{j.delivered.toFixed(0)}/{j.qty}</td>
              <td className="numeric mono good">Ç{j.reward.toLocaleString()}</td>
              <td className={`numeric mono ${expiringSoon ? "warn" : "dim"}`}>{ticksLeft}t</td>
              <td>
                <button
                  className="btn-action"
                  onClick={() => abandonJob(j.id)}
                  title={j.penalty > 0 ? `Abandoning costs Ç${j.penalty.toLocaleString()}` : "Abandon (no penalty)"}
                >
                  <span className="btn-label">Abandon</span>
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// "Hire offers" sits next to Market in the bottom split — same tabbed pattern
// as Cargo|Crew above. Lists posted offers at the docked station with their
// expiry countdown; rows are sorted tier asc / cost asc by listHiresAt.
function HireOffersTab({ ship, world }: { ship: Trader; world: World }) {
  const hire = useStore((s) => s.hireCrew);
  const player = world.player;
  const offers = listHiresAt(world, ship.location);
  const docked = ship.state === "idle";

  return (
    <table className="jobs-table">
      <colgroup>
        <col className="col-tier" />
        <col className="col-role" />
        <col />
        <col className="col-num" />
        <col className="col-num" />
        <col className="col-num" />
        <col className="col-action" />
      </colgroup>
      <thead>
        <tr>
          <th>Tier</th>
          <th>Role</th>
          <th>Candidate</th>
          <th className="numeric">Wage</th>
          <th className="numeric">Hire</th>
          <th className="numeric">Expires</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {offers.length === 0 ? (
          <tr><td colSpan={7} className="jobs-row-empty">No crew posted at {world.locations[ship.location]?.name ?? ship.location}.</td></tr>
        ) : offers.map((h) => {
          const ticksLeft = Math.max(0, h.expiresAt - world.tick);
          const expiringSoon = ticksLeft <= 15;
          const mods = modifiersText(h.modifiers);
          const canAfford = (player?.funds ?? 0) >= h.hireCost;
          return (
            <tr key={h.id} className={`job-row tier-${tierClass(h.tier)}`}>
              <td><span className={`tier-badge tier-${tierClass(h.tier)}`}>T{h.tier}</span></td>
              <td>{ROLE_SHORT[h.role]}</td>
              <td>
                <span className="crew-name">{h.name}</span>
                {mods && <span className="crew-mods dim" title={mods}> · {mods}</span>}
              </td>
              <td className="numeric mono dim">Ç{h.wagePerTick}/t</td>
              <td className="numeric mono">Ç{h.hireCost.toLocaleString()}</td>
              <td className={`numeric mono ${expiringSoon ? "warn" : "dim"}`}>{ticksLeft}t</td>
              <td>
                <button
                  className={`btn-action ${canAfford && docked ? "primary" : ""}`}
                  onClick={() => hire(ship.id, h.id)}
                  disabled={!canAfford || !docked}
                  title={!docked ? "Dock to hire" : !canAfford ? `Need Ç${h.hireCost.toLocaleString()}` : "Sign on (replaces any existing in this role)"}
                >
                  <span className="btn-label">Hire</span>
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const ROLE_SHORT: Record<CrewRole, string> = {
  captain: "Captain", navigator: "Navigator", mechanic: "Mechanic",
};

function tierClass(tier: number): "high" | "medium" | "low" {
  // Reuse the jobs tier coloring so T3 = hot/expensive (red), T1 = baseline.
  return tier >= 3 ? "high" : tier === 2 ? "medium" : "low";
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
