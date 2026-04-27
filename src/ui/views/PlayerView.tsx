import { useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { IconType } from "react-icons";
import {
  GiAstronautHelmet,
  GiAutoRepair,
  GiCargoCrate,
  GiContract,
  GiFactory,
  GiFuelTank,
  GiHabitatDome,
  GiPathDistance,
  GiRadarSweep,
  GiShipWheel,
  GiSpeedometer,
  GiTrade,
  GiWallet,
} from "react-icons/gi";
import { useStore } from "../store";
import { distance, reachableNeighbors } from "../../sim/geometry";
import { describeHint, getGuidedHint, hintTarget, type HintTarget } from "../../sim/suggestions";
import { SALES_TAX_RATE } from "../../sim/economy";
import { cargoMass as cargoMassFn, findCargoLot, groupCargoByGood, type CargoGroup } from "../../sim/cargo";
import { listAvailableRescueJobs, listLocalJobs } from "../../sim/jobs";
import { hasCrew, totalCrewWage } from "../../sim/crew";
import { MAINTENANCE_DEBT_TRAVEL_BLOCK } from "../../sim/crew";
import { listHiresAt } from "../../sim/hires";
import { selectRefuelType } from "../../sim/traders";
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

function IconLabel({ icon: Icon, children }: { icon: IconType; children: ReactNode }) {
  return (
    <span className="icon-label">
      <Icon className="ui-icon" aria-hidden="true" focusable="false" />
      <span>{children}</span>
    </span>
  );
}

function DetailChip({ icon: Icon, label, value }: { icon: IconType; label: string; value: ReactNode }) {
  return (
    <span className="detail-chip">
      <Icon className="ui-icon" aria-hidden="true" focusable="false" />
      <span className="detail-chip-label">{label}</span>
      <span className="detail-chip-value">{value}</span>
    </span>
  );
}

function SingleTabHeader({ label, count, icon }: { label: string; count?: number; icon?: IconType }) {
  return (
    <div className="bridge-card-tabs bridge-card-tabs-static">
      <span className="bridge-tab active">
        {icon ? <IconLabel icon={icon}>{label}</IconLabel> : label}
        {count != null && <span className="bridge-tab-count">{count}</span>}
      </span>
    </div>
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
        <ShipCard ship={ship} world={world} target={target} hintText={hintText} critical={critical} inTransit={inTransit} />
        <StationCard loc={loc} world={world} inTransit={inTransit} />
        <CargoBridgeCard ship={ship} world={world} loc={loc} inTransit={inTransit} />
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
      <ShipLogCard ship={ship} />
    </div>
  );
}

function ShipLogCard({ ship }: { ship: Trader }) {
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
  // Remote shortage contracts the player can act on right now because their
  // cargo matches — keeps the suggestion engine's "accept this remote contract"
  // hint actionable in this list (otherwise the highlighted Accept button has
  // nowhere to render).
  const cargoGoods = new Set(ship.cargo.map(l => l.good));
  const remoteActionable = Object.values(world.jobs).filter(j =>
    j.acceptedBy == null
    && j.kind === "shortage"
    && j.destination !== loc.id
    && cargoGoods.has(j.good)
    && !seen.has(j.id)
  );
  for (const j of remoteActionable) seen.add(j.id);
  const jobs = [...local, ...remoteRescues, ...remoteActionable].sort(localJobSort);

  return (
    <section className="bridge-card local-jobs-card">
      <header className="bridge-card-head">
        <SingleTabHeader label="Contracts" count={jobs.length} icon={GiContract} />
      </header>
      {jobs.length === 0 ? (
        <div className="contract-empty">No open contracts here and no distress calls active.</div>
      ) : (
        <div className="contract-list">
          {jobs.map((j) => (
            <LocalJobRow
              key={j.id}
              job={j}
              world={world}
              ship={ship}
              suggested={target.acceptJobId === j.id}
              hintText={hintText}
              onAccept={() => acceptJob(j.id, ship.id)}
            />
          ))}
        </div>
      )}
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
  const dst = world.locations[job.destination]?.name ?? job.destination;
  const remote = job.destination !== ship.location;
  return (
    <article className={`contract-card contract-tier-${job.tier} ${suggested ? "contract-suggested" : ""}`}>
      <div className="contract-main">
        <div className="contract-title-row">
          <span className={`tier-badge tier-${job.tier}`}>{job.tier.toUpperCase()}</span>
          <span className="contract-good">{good}</span>
          {job.kind === "rescue" && (
            <span className="job-kind-tag" title={job.rescueTarget ? `Rescue ${world.traders[job.rescueTarget]?.name ?? job.rescueTarget}` : "Rescue contract"}>
              rescue
            </span>
          )}
        </div>
        <div className="contract-route dim mono">
          {remote ? `Deliver to ${dst}` : `Deliver here`}
        </div>
        <div className="contract-metrics">
          <ContractMetric label="Qty" value={job.qty.toLocaleString()} />
          <ContractMetric label="In hold" value={onHand > 0 ? onHand.toFixed(0) : "none"} tone={onHandTone} />
          <ContractMetric label="Reward" value={`Ç${job.reward.toLocaleString()}`} tone="good" />
          <ContractMetric label="Penalty" value={job.penalty > 0 ? `Ç${job.penalty.toLocaleString()}` : "none"} tone={job.penalty > 0 ? "bad" : "faint"} />
          <ContractMetric label="Expires" value={`${ticksLeft}t`} tone={expiringSoon ? "warn" : "dim"} />
        </div>
      </div>
      <div className="contract-actions">
        <ActionCell suggested={suggested} hintText={hintText}>
          <button className={`btn-action ${suggested ? "btn-suggested" : "primary"}`} onClick={onAccept}>
            <span className="btn-label">Accept</span>
          </button>
        </ActionCell>
      </div>
    </article>
  );
}

function ContractMetric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <span className="contract-metric">
      <span className="contract-metric-label">{label}</span>
      <span className={`contract-metric-value mono ${tone ?? ""}`}>{value}</span>
    </span>
  );
}

function TransitCard({ ship, world }: { ship: Trader; world: World }) {
  const stepN = useStore((s) => s.stepN);
  // Recover total trip ticks from origin/destination distance — same math the
  // sim used on departure (ship.location is still the ORIGIN until arrival).
  const tripDist = distance(world, ship.location, ship.destination!);
  const totalTicks = Math.max(1, Math.ceil(tripDist / ship.speed));
  const elapsed = totalTicks - ship.ticksRemaining;
  const pct = Math.max(0, Math.min(100, (elapsed / totalTicks) * 100));

  return (
    <section className="bridge-card travel-card">
      <header className="bridge-card-head">
        <SingleTabHeader label="Travel" icon={GiPathDistance} />
        <button
          className="btn-action btn-header-inline"
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
  const population = loc.population >= 1000 ? `${(loc.population / 1000).toFixed(1)}k` : loc.population.toLocaleString();

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
        <div className="detail-row station-detail-row">
          <DetailChip icon={GiFactory} label="Tech" value={`L${loc.traits.techLevel}`} />
          <DetailChip icon={GiHabitatDome} label="Pop" value={population} />
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

function ShipCard({ ship, world, target, hintText, critical, inTransit }: {
  ship: Trader; world: World; target: HintTarget; hintText: string; critical: boolean; inTransit: boolean;
}) {
  const setPilot = useStore((s) => s.setPilot);
  const repairShip = useStore((s) => s.repairShip);
  const mass = cargoMassFn(ship, world);
  const cargoPct = (mass / ship.capacity) * 100;

  const debt = ship.maintenanceDebt ?? 0;
  const canRepair = debt > 0 && ship.state === "idle";
  const autoBlocked = !hasCrew(ship, "captain");

  return (
    <section className="bridge-card ship-card">
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow ship-eyebrow">Ship</span>
          <span className="ship-name">{ship.name}</span>
          <div className="detail-row ship-detail-row">
            <DetailChip icon={GiCargoCrate} label="Capacity" value={ship.capacity.toLocaleString()} />
            <DetailChip icon={GiSpeedometer} label="Speed" value={ship.speed.toLocaleString()} />
          </div>
        </div>
        <div className="ship-pilot">
          <button
            className={ship.pilot === "manual" ? "primary" : ""}
            onClick={() => setPilot(ship.id, "manual")}
          >
            <IconLabel icon={GiShipWheel}>Manual</IconLabel>
          </button>
          <button
            className={ship.pilot === "auto" ? "primary" : ""}
            onClick={() => setPilot(ship.id, "auto")}
            disabled={autoBlocked}
            title={autoBlocked ? "Hire a captain to engage auto-pilot" : "Auto-pilot (captain handles trades; navigator unlocks contracts)"}
          >
            <IconLabel icon={GiRadarSweep}>Auto</IconLabel>
          </button>
        </div>
      </header>
      <div className="ship-system-grid">
        <CargoSpacePanel used={mass} capacity={ship.capacity} pct={cargoPct} />
        <WalletPanel funds={ship.funds} />
      </div>
      <FuelPanel ship={ship} world={world} target={target} hintText={hintText} critical={critical} inTransit={inTransit} />
      <MaintenancePanel debt={debt} canRepair={canRepair} onRepair={() => repairShip(ship.id)} />
    </section>
  );
}

function CargoSpacePanel({ used, capacity, pct }: { used: number; capacity: number; pct: number }) {
  const tone = "";

  return (
    <div className={`ship-system-panel ship-cargo-panel ${tone}`} title={`${pct.toFixed(0)}% cargo capacity used`}>
      <div className="ship-system-top">
        <span className="ship-system-label dim"><IconLabel icon={GiCargoCrate}>Cargo</IconLabel></span>
      </div>
      <div className="ship-system-meter">
        <div className={`ship-system-meter-fill ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
        <span className="ship-system-meter-value">{used.toFixed(0)}/{capacity}</span>
      </div>
    </div>
  );
}

function WalletPanel({ funds }: { funds: number }) {
  return (
    <div className="ship-system-panel ship-wallet-panel">
      <div className="ship-system-top">
        <span className="ship-system-label dim"><IconLabel icon={GiWallet}>Wallet</IconLabel></span>
      </div>
      <div className="ship-wallet-pill mono">Ç{Math.round(funds).toLocaleString()}</div>
    </div>
  );
}

function FuelPanel({ ship, world, target, hintText, critical, inTransit }: {
  ship: Trader; world: World; target: HintTarget; hintText: string; critical: boolean; inTransit: boolean;
}) {
  const refuel = useStore((s) => s.refuel);
  const fuel = ship.currentFuel;
  const fuelQty = fuel?.qty ?? 0;
  const fuelPct = ship.fuelCapacity > 0 ? (fuelQty / ship.fuelCapacity) * 100 : 0;
  const tone = fuelPct < 25 ? "bad" : fuelPct < 50 ? "warn" : "";
  const tankGood = fuel ? world.goods[fuel.good]?.name ?? fuel.good : "No fuel";
  const refuelType = inTransit ? null : selectRefuelType(world, ship);
  const market = refuelType ? world.markets[ship.location] : null;
  const stationFuel = refuelType ? world.goods[refuelType.good]?.name ?? refuelType.good : null;
  const stock = refuelType && market ? market.stock[refuelType.good] ?? 0 : 0;
  const price = refuelType && market ? market.prices[refuelType.good] ?? 0 : 0;
  const switching = refuelType != null && (!fuel || fuel.good !== refuelType.good);
  const room = Math.max(0, ship.fuelCapacity - (switching ? 0 : fuelQty));
  const affordable = price > 0 ? ship.funds / price : 0;
  const fillable = refuelType ? Math.min(room, stock, affordable) : 0;
  const suggested = target.refuel === true && !inTransit;
  const canRefuel = !inTransit && refuelType != null && fillable > 0.001;

  const status = inTransit
    ? "Dock to refuel"
    : refuelType
      ? `Station: ${stationFuel} · ${stock.toFixed(0)} stock · Ç${Math.round(price)}/u`
      : "No compatible fuel at station";

  const disabledTitle = room <= 0.001
    ? "Tank already full"
    : stock <= 0.001
      ? "No compatible fuel for sale here"
      : "Not enough funds to refuel";

  const action = inTransit
    ? <span className="ship-fuel-badge">In transit</span>
    : !refuelType
      ? <span className="ship-fuel-badge bad">No fuel here</span>
      : room <= 0.001
        ? <span className="ship-fuel-badge">Full</span>
        : (
          <ActionCell suggested={suggested} hintText={hintText} critical={critical}>
            <button
              className={`btn-action ship-fuel-action ${critical ? "btn-suggested-critical" : suggested ? "btn-suggested" : "primary"}`}
              onClick={() => refuel(ship.id)}
              disabled={!canRefuel}
              title={canRefuel ? "" : disabledTitle}
            >
              <span className="btn-label">{critical ? "Refuel" : switching ? "Switch fuel" : "Fill tank"}</span>
            </button>
          </ActionCell>
        );

  return (
    <div className={`ship-system-panel ship-fuel-panel ${tone} ${suggested ? "suggested" : ""}`} title={status}>
      <div className="ship-fuel-main">
        <div className="ship-fuel-top">
          <span className="ship-fuel-label dim"><IconLabel icon={GiFuelTank}>Fuel</IconLabel></span>
        </div>
        <div className="ship-system-meter ship-fuel-meter">
          <div className={`ship-fuel-meter-fill ${tone}`} style={{ width: `${Math.min(100, fuelPct)}%` }} />
          <span className="ship-system-meter-value">{fuelQty.toFixed(0)}/{ship.fuelCapacity} · {tankGood}</span>
        </div>
      </div>
      <div className="ship-fuel-control">{action}</div>
    </div>
  );
}

function MaintenancePanel({ debt, canRepair, onRepair }: { debt: number; canRepair: boolean; onRepair: () => void }) {
  const pct = Math.max(0, Math.min(100, (debt / MAINTENANCE_DEBT_TRAVEL_BLOCK) * 100));
  const grounded = debt >= MAINTENANCE_DEBT_TRAVEL_BLOCK;
  const tone = grounded ? "bad" : pct >= 70 ? "warn" : "";
  const hasDebt = debt > 0.001;
  const status = grounded
    ? "Grounded"
    : hasDebt
      ? "Service debt"
      : "No service debt";
  const limitText = `limit Ç${MAINTENANCE_DEBT_TRAVEL_BLOCK.toLocaleString()}`;
  const action = hasDebt ? (
    <button
      className={`btn-action maintenance-action ${grounded ? "btn-suggested-critical" : ""}`}
      onClick={onRepair}
      disabled={!canRepair}
      title={canRepair ? "Pay accrued maintenance" : "Dock to repair"}
    >
      <span className="btn-label">Repair</span>
    </button>
  ) : <span className="ship-maintenance-badge">Clear</span>;

  return (
    <div className={`ship-system-panel ship-maintenance-panel ${tone}`} title={`${status} · ${limitText}`}>
      <div className="ship-maintenance-main">
        <div className="ship-maintenance-top">
          <span className="ship-maintenance-label dim"><IconLabel icon={GiAutoRepair}>Maintenance</IconLabel></span>
        </div>
        <div className="ship-system-meter ship-maintenance-meter">
          <div className={`ship-maintenance-meter-fill ${tone}`} style={{ width: `${pct}%` }} />
          <span className="ship-system-meter-value">Ç{Math.round(debt).toLocaleString()} · {limitText}</span>
        </div>
      </div>
      <div className="ship-maintenance-control">{action}</div>
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
            <IconLabel icon={GiTrade}>Market</IconLabel>
          </button>
          <button className={`bridge-tab ${tab === "offers" ? "active" : ""}`} onClick={() => setTab("offers")}>
            <IconLabel icon={GiAstronautHelmet}>Hire offers</IconLabel> <span className="bridge-tab-count">{offers.length}</span>
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
  const goodsOrdered = Object.keys(world.goods).filter((gid) =>
    (market.stock[gid] ?? 0) > 0.001 || findCargoLot(ship, gid) != null
  );

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
            const isSellTarget = target.sellGood === gid && isCargo;
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
                    recommendedBuyQty={isBuyTarget ? target.buyQty : undefined}
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
  ship, world, goodId, stock, price, cargoQty, suggestedBuy, suggestedSell, hintText, recommendedBuyQty, onBuy, onSell,
}: {
  ship: Trader; world: World; goodId: string; stock: number; price: number; cargoQty: number;
  suggestedBuy: boolean; suggestedSell: boolean; hintText: string;
  recommendedBuyQty?: number;
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

  // When the row is suggested-buy and the engine has provided a specific qty
  // (typically reduced to leave room for accepted-contract goods at the same
  // destination), the button buys THAT qty instead of bay-max. Player can
  // still override with +10 or buy-max if they want everything.
  const suggestedQty = suggestedBuy && recommendedBuyQty != null && recommendedBuyQty > 0
    ? Math.min(recommendedBuyQty, maxBuy)
    : null;
  const buyClickQty = suggestedQty ?? maxBuy;
  const buyLabel = suggestedQty != null ? "Buy" : "Buy max";

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
          onClick={() => onBuy(buyClickQty)}
          disabled={!canBuyMax}
          title={canBuyMax ? "" : buyTitle}
        >
          <span className="btn-label">{buyLabel}</span>
          <span className="btn-count">{buyClickQty}</span>
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

function CargoBridgeCard({ ship, world, loc, inTransit }: {
  ship: Trader; world: World; loc: LocationDef; inTransit: boolean;
}) {
  const [tab, setTab] = useState<"cargo" | "crew" | "active">("cargo");
  // Player ships only — accepted contracts attached to this ship.
  const activeJobs = Object.values(world.jobs).filter(j => j.acceptedBy === ship.id);
  const groups = groupCargoByGood(ship);

  return (
    <section className="bridge-card cargo-bridge-card">
      <header className="bridge-card-head">
        <div className="bridge-card-tabs">
          <button
            className={`bridge-tab ${tab === "cargo" ? "active" : ""}`}
            onClick={() => setTab("cargo")}
          >
            <IconLabel icon={GiCargoCrate}>Cargo</IconLabel> {ship.cargo.length > 0 && <span className="bridge-tab-count">{ship.cargo.length}</span>}
          </button>
          <button
            className={`bridge-tab ${tab === "crew" ? "active" : ""}`}
            onClick={() => setTab("crew")}
          >
            <IconLabel icon={GiAstronautHelmet}>Crew</IconLabel> <span className="bridge-tab-count">{Object.keys(ship.crew ?? {}).length}/3</span>
          </button>
          <button
            className={`bridge-tab ${tab === "active" ? "active" : ""}`}
            onClick={() => setTab("active")}
          >
            <IconLabel icon={GiContract}>Contracts</IconLabel> {activeJobs.length > 0 && <span className="bridge-tab-count">{activeJobs.length}</span>}
          </button>
        </div>
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

  const { ref: tooltipRef, handlers: tooltipHandlers, portal: tooltipPortal } = useHoverTooltip<HTMLTableRowElement>(tooltip);

  return (
    <>
      <tr className="cargo-row" ref={tooltipRef} {...tooltipHandlers}>
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
      {tooltipPortal}
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
    <>
      {sorted.length === 0 ? (
        <div className="contract-empty">No active contracts.</div>
      ) : (
        <div className="contract-list active-contracts-list">
          {sorted.map((j) => {
          const ticksLeft = Math.max(0, j.expiresAt - world.tick);
          const expiringSoon = ticksLeft <= 10;
          const dst = world.locations[j.destination]?.name ?? j.destination;
          const good = world.goods[j.good]?.name ?? j.good;
          const away = j.destination !== ship.location;
          const pct = j.qty > 0 ? Math.max(0, Math.min(100, (j.delivered / j.qty) * 100)) : 0;
          return (
            <article key={j.id} className={`contract-card contract-tier-${j.tier} contract-active`}>
              <div className="contract-main">
                <div className="contract-title-row">
                  <span className={`tier-badge tier-${j.tier}`}>{j.tier.toUpperCase()}</span>
                  <span className="contract-good">{good}</span>
                  {j.kind === "rescue" && <span className="job-kind-tag">rescue</span>}
                </div>
                <div className="contract-route dim mono">
                  {away ? `Deliver to ${dst}` : `Deliver here`}
                </div>
                <div className="contract-progress">
                  <div className="contract-progress-bar">
                    <div className="contract-progress-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="mono dim">{j.delivered.toFixed(0)}/{j.qty}</span>
                </div>
                <div className="contract-metrics">
                  <ContractMetric label="Reward" value={`Ç${j.reward.toLocaleString()}`} tone="good" />
                  <ContractMetric label="Penalty" value={j.penalty > 0 ? `Ç${j.penalty.toLocaleString()}` : "none"} tone={j.penalty > 0 ? "bad" : "faint"} />
                  <ContractMetric label="Expires" value={`${ticksLeft}t`} tone={expiringSoon ? "warn" : "dim"} />
                </div>
              </div>
              <div className="contract-actions">
                <button
                  className="btn-action"
                  onClick={() => abandonJob(j.id)}
                  title={j.penalty > 0 ? `Abandoning costs Ç${j.penalty.toLocaleString()}` : "Abandon (no penalty)"}
                >
                  <span className="btn-label">Abandon</span>
                </button>
              </div>
            </article>
          );
        })}
        </div>
      )}
    </>
  );
}

// "Hire offers" sits next to Market in the bottom split — same tabbed pattern
// as Cargo|Crew above. Lists posted offers at the docked station with their
// expiry countdown; rows are sorted tier asc / cost asc by listHiresAt.
function HireOffersTab({ ship, world }: { ship: Trader; world: World }) {
  const hire = useStore((s) => s.hireCrew);
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
          const canAfford = ship.funds >= h.hireCost;
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
        <SingleTabHeader label="Travel" icon={GiPathDistance} />
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
