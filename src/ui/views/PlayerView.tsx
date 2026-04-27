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
import { describeHint, getGuidedHint, hintTarget, type GuidedHint, type HintTarget } from "../../sim/suggestions";
import { DOCKING_FEE_PER_CAPACITY, MAINTENANCE_PER_CAPACITY, SALES_TAX_RATE } from "../../sim/economy";
import { cargoMass as cargoMassFn, findCargoLot, groupCargoByGood, type CargoGroup } from "../../sim/cargo";
import { listLocalJobs } from "../../sim/jobs";
import { effectivePerDistance, hasCrew, totalCrewWage } from "../../sim/crew";
import { MAINTENANCE_DEBT_TRAVEL_BLOCK } from "../../sim/crew";
import { listHiresAt } from "../../sim/hires";
import { selectRefuelType } from "../../sim/traders";
import { UPGRADE_SLOTS, installedUpgrade, isUpgradeGood, upgradeDef, upgradeEffectText, upgradeStars } from "../../sim/upgrades";
import type { CrewModifiers, CrewRole } from "../../sim/types";
import type { GoodId, Job, LocationDef, LocationId, Trader, UpgradeSlot, World } from "../../sim/types";
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
  const hint = getGuidedHint(world, ship, { mode: ship.pilot === "auto" ? "actual" : "advisory" });
  const target = hintTarget(hint);
  const hintText = describeHint(hint, world);
  const isCriticalHint = hint.kind === "refuel" && hint.critical;

  return (
    <article className="ship-panel">
      <DockedView
        ship={ship}
        world={world}
        loc={focusLoc!}
        hint={hint}
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

function SuggestedMarker({ tip, critical, label = "Suggested" }: { tip: string; critical?: boolean; label?: string }) {
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
          <span className="suggested-tooltip-label">{label}</span>
          {tip}
        </span>,
        document.body,
      )}
    </span>
  );
}

function ActionCell({ suggested, hintText, critical, label, children }: {
  suggested: boolean; hintText: string; critical?: boolean; label?: string; children: ReactNode;
}) {
  return (
    <span className="action-cell">
      {suggested && <SuggestedMarker tip={hintText} critical={critical} label={label} />}
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

function formatQty(qty: number | undefined): string {
  if (qty == null) return "";
  if (qty >= 100) return Math.round(qty).toLocaleString();
  return Number.isInteger(qty) ? qty.toFixed(0) : qty.toFixed(1);
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

type TradeHelperFocus = { good: GoodId; source: "market" | "cargo" };

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

function DockedView({ ship, world, loc, hint, target, hintText, critical, inTransit }: {
  ship: Trader; world: World; loc: LocationDef; hint: GuidedHint; target: HintTarget; hintText: string; critical: boolean; inTransit: boolean;
}) {
  const [selectedFocus, setSelectedFocus] = useState<TradeHelperFocus | null>(null);
  const [hoveredFocus, setHoveredFocus] = useState<TradeHelperFocus | null>(null);
  const activeFocus = hoveredFocus ?? selectedFocus;
  const selectFocus = (focus: TradeHelperFocus) => {
    setSelectedFocus(prev => prev?.good === focus.good && prev.source === focus.source ? null : focus);
  };

  return (
    <div className="docked-view">
      <div className="bridge">
        <ShipCard ship={ship} world={world} hint={hint} target={target} hintText={hintText} critical={critical} inTransit={inTransit} />
        <StationCard loc={loc} world={world} inTransit={inTransit} />
        <CargoBridgeCard
          ship={ship}
          world={world}
          loc={loc}
          inTransit={inTransit}
          target={target}
          hintText={hintText}
          selectedGood={activeFocus?.source === "cargo" ? activeFocus.good : null}
          onSelectGood={(good) => selectFocus({ good, source: "cargo" })}
          onHoverGood={(good) => setHoveredFocus(good ? { good, source: "cargo" } : null)}
        />
        {inTransit
          ? <TransitCard ship={ship} world={world} />
          : <TravelOptions ship={ship} world={world} target={target} hintText={hintText} />}
      </div>
      {inTransit
        ? <TransitMarketPlaceholder destName={loc.name} ticksRemaining={ship.ticksRemaining} />
        : (
          <div className="bridge-split">
            <StationExchangeCard
              ship={ship}
              world={world}
              loc={loc}
              target={target}
              hintText={hintText}
              selectedGood={activeFocus?.source === "market" ? activeFocus.good : null}
              onSelectGood={(good) => selectFocus({ good, source: "market" })}
              onHoverGood={(good) => setHoveredFocus(good ? { good, source: "market" } : null)}
            />
            <TradeHelperCard ship={ship} world={world} loc={loc} focus={activeFocus} target={target} hint={hint} />
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

function ContractsTab({ ship, world, loc, target, hintText }: {
  ship: Trader; world: World; loc: LocationDef; target: HintTarget; hintText: string;
}) {
  const acceptJob = useStore((s) => s.acceptJob);
  const manualActions = ship.pilot !== "auto";
  const activeJobs = Object.values(world.jobs).filter(j => j.acceptedBy === ship.id);
  // Keep this as a station-local board. Remote jobs only appear here when the
  // guidance engine is explicitly pointing at their Accept button.
  const local = listLocalJobs(world, loc.id);
  const seen = new Set(local.map(j => j.id));
  const suggestedIds = new Set<Job["id"]>();
  if (target.acceptJobId) suggestedIds.add(target.acceptJobId);
  for (const id of target.acceptJobIds ?? []) suggestedIds.add(id);
  const remoteSuggested = Object.values(world.jobs).filter(j =>
    j.acceptedBy == null
    && j.destination !== loc.id
    && suggestedIds.has(j.id)
    && !seen.has(j.id)
  );
  const jobs = [...remoteSuggested, ...local].sort((a, b) =>
    Number(suggestedIds.has(b.id)) - Number(suggestedIds.has(a.id))
    || localJobSort(a, b)
  );

  return (
    <div className="contracts-tab">
      {activeJobs.length > 0 && (
        <div className="contract-section">
          <div className="exchange-section-title">Active</div>
          <ActiveContractsTab ship={ship} world={world} jobs={activeJobs} />
        </div>
      )}
      <div className="contract-section">
        <div className="exchange-section-title">Available here</div>
        {jobs.length === 0 ? (
          <div className="contract-empty">No open contracts here.</div>
        ) : (
          <div className="contract-list">
            {jobs.map((j) => (
              <LocalJobRow
                key={j.id}
                job={j}
                world={world}
                ship={ship}
                suggested={target.acceptJobId === j.id || target.acceptJobIds?.includes(j.id) === true}
                hintText={hintText}
                showAction={manualActions}
                onAccept={() => acceptJob(j.id, ship.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const TIER_RANK: Record<Job["tier"], number> = { high: 0, medium: 1, low: 2 };
function localJobSort(a: Job, b: Job): number {
  const t = TIER_RANK[a.tier] - TIER_RANK[b.tier];
  return t !== 0 ? t : a.expiresAt - b.expiresAt;
}

function LocalJobRow({ job, world, ship, suggested, hintText, showAction, onAccept }: {
  job: Job; world: World; ship: Trader; suggested: boolean; hintText: string; showAction: boolean; onAccept: () => void;
}) {
  const good = world.goods[job.good]?.name ?? job.good;
  const ticksLeft = Math.max(0, job.expiresAt - world.tick);
  const expiringSoon = ticksLeft <= 10;
  const onHand = ship.cargo.filter(l => l.good === job.good).reduce((s, l) => s + l.qty, 0);
  const onHandTone = onHand >= job.qty ? "good" : onHand > 0 ? "warn" : "faint";
  const dst = world.locations[job.destination]?.name ?? job.destination;
  const remote = job.destination !== ship.location;
  return (
    <article className={`contract-card contract-tier-${job.tier} ${suggested ? "contract-suggested" : ""} ${!showAction ? "contract-card-readonly" : ""}`}>
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
      {showAction && (
        <div className="contract-actions">
          <ActionCell suggested={suggested} hintText={hintText}>
            <button className={`btn-action ${suggested ? "btn-suggested" : "primary"}`} onClick={onAccept}>
              <span className="btn-label">Accept</span>
            </button>
          </ActionCell>
        </div>
      )}
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
  const manualActions = ship.pilot !== "auto";
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
        {manualActions && (
          <button
            className="btn-action btn-header-inline"
            onClick={() => stepN(ship.ticksRemaining)}
            title={`Advance ${ship.ticksRemaining} ticks until arrival`}
          >
            <span className="btn-label">Quick Travel</span>
          </button>
        )}
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

function ShipCard({ ship, world, hint, target, hintText, critical, inTransit }: {
  ship: Trader; world: World; hint: GuidedHint; target: HintTarget; hintText: string; critical: boolean; inTransit: boolean;
}) {
  const setPilot = useStore((s) => s.setPilot);
  const repairShip = useStore((s) => s.repairShip);
  const mass = cargoMassFn(ship, world);
  const cargoPct = (mass / ship.capacity) * 100;

  const debt = ship.maintenanceDebt ?? 0;
  const canRepair = debt > 0 && ship.state === "idle";
  const autoBlocked = !hasCrew(ship, "captain");
  const installedCount = Object.keys(ship.upgrades ?? {}).length;

  return (
    <section className="bridge-card ship-card">
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow ship-eyebrow">Ship</span>
          <span className="ship-name">{ship.name}</span>
          <div className="detail-row ship-detail-row">
            <DetailChip icon={GiCargoCrate} label="Capacity" value={ship.capacity.toLocaleString()} />
            <DetailChip icon={GiSpeedometer} label="Speed" value={ship.speed.toLocaleString()} />
            <DetailChip icon={GiAutoRepair} label="Hull" value={(ship.hull ?? ship.baseHull ?? 1).toLocaleString()} />
            <DetailChip icon={GiRadarSweep} label="Weapons" value={(ship.weaponPower ?? ship.baseWeaponPower ?? 0).toLocaleString()} />
            <DetailChip icon={GiFactory} label="Slots" value={`${installedCount}/5`} />
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
      <ShipPlanPanel ship={ship} world={world} hint={hint} hintText={hintText} />
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

type PlanTone = "" | "warn" | "bad";
type PlanStep = { icon: IconType; text: string; tone?: PlanTone };
type ShipPlan = { label: string; meta: string; tone: PlanTone; steps: PlanStep[]; note?: string };

function ShipPlanPanel({ ship, world, hint, hintText }: {
  ship: Trader; world: World; hint: GuidedHint; hintText: string;
}) {
  const plan = buildShipPlan(ship, world, hint, hintText);

  return (
    <div className={`ship-plan-panel ${plan.tone}`}>
      <div className="ship-plan-head">
        <span className="ship-plan-label">{plan.label}</span>
        <span className="ship-plan-meta mono">{plan.meta}</span>
      </div>
      <ol className="ship-plan-steps">
        {plan.steps.map((step, i) => {
          const Icon = step.icon;
          return (
            <li key={`${step.text}-${i}`} className={step.tone ? `tone-${step.tone}` : ""}>
              <Icon className="ui-icon" aria-hidden="true" focusable="false" />
              <span>{step.text}</span>
            </li>
          );
        })}
      </ol>
      {plan.note && <div className="ship-plan-note dim">{plan.note}</div>}
    </div>
  );
}

function buildShipPlan(ship: Trader, world: World, hint: GuidedHint, hintText: string): ShipPlan {
  const label = ship.pilot === "auto" ? "Auto plan" : "Suggested plan";
  const goodName = (id: string) => world.goods[id]?.name ?? id;
  const locName = (id: string) => world.locations[id]?.name ?? id;
  const itemList = (items: { good: string; qty: number }[]) =>
    items.map(item => `${formatQty(item.qty)} ${goodName(item.good)}`).join(", ");
  const contractText = (count: number) => `${count} contract${count === 1 ? "" : "s"}`;

  if (ship.state === "transit") {
    const destination = locName(ship.destination ?? ship.location);
    return {
      label: "En route",
      meta: `${ship.ticksRemaining}t remaining`,
      tone: "",
      steps: [
        { icon: GiPathDistance, text: `Arrive at ${destination}` },
      ],
    };
  }

  switch (hint.kind) {
    case "refuel":
      return {
        label,
        meta: hint.critical ? "critical" : "fuel",
        tone: hint.critical ? "bad" : "warn",
        steps: [{ icon: GiFuelTank, text: "Refuel before leaving", tone: hint.critical ? "bad" : "warn" }],
        note: hint.reason,
      };
    case "buy_for_route":
      return {
        label,
        meta: `Ç${Math.round(hint.netProfit).toLocaleString()} · ${hint.ticks}t`,
        tone: "",
        steps: [
          { icon: GiCargoCrate, text: `Buy ${formatQty(hint.qty)} ${goodName(hint.good)}` },
          { icon: GiPathDistance, text: `Fly to ${locName(hint.dst)}` },
          { icon: GiTrade, text: "Sell cargo" },
        ],
      };
    case "travel_to_sell":
      return {
        label,
        meta: `Ç${Math.round(hint.expectedNet).toLocaleString()} · ${hint.ticks}t`,
        tone: "",
        steps: [
          { icon: GiPathDistance, text: `Fly to ${locName(hint.dst)}` },
          ...(hint.jobId && hint.jobAccepted === false
            ? [{ icon: GiContract, text: "Accept matching contract" } satisfies PlanStep]
            : []),
          { icon: GiTrade, text: `Sell ${formatQty(hint.qty)} ${goodName(hint.good)}` },
        ],
      };
    case "sell_here":
      return {
        label,
        meta: `Ç${Math.round(hint.revenue).toLocaleString()}`,
        tone: "",
        steps: [{ icon: GiTrade, text: `Sell ${formatQty(hint.qty)} ${goodName(hint.good)} here` }],
      };
    case "speculate":
      return {
        label,
        meta: `Ç${Math.round(hint.netProfit).toLocaleString()} · ${hint.ticks}t`,
        tone: "",
        steps: [
          { icon: GiPathDistance, text: `Reposition to ${locName(hint.via)}` },
          { icon: GiCargoCrate, text: `Buy ${goodName(hint.thenBuy)}` },
          { icon: GiTrade, text: `Sell at ${locName(hint.thenSellAt)}` },
        ],
      };
    case "accept_job":
      return {
        label,
        meta: `Ç${Math.round(hint.expectedNet).toLocaleString()} · ${hint.ticks}t`,
        tone: "",
        steps: [{ icon: GiContract, text: "Accept contract" }],
        note: hint.reason,
      };
    case "route_plan": {
      const steps: PlanStep[] = [];
      if (hint.acceptJobIds.length > 0) steps.push({ icon: GiContract, text: `Accept ${contractText(hint.acceptJobIds.length)}` });
      if (hint.loaded && hint.loaded.length > 0) steps.push({ icon: GiCargoCrate, text: `Keep ${itemList(hint.loaded)} loaded` });
      if (hint.buys.length > 0) steps.push({ icon: GiCargoCrate, text: `Load ${itemList(hint.buys)}` });
      steps.push({ icon: GiPathDistance, text: `Fly to ${locName(hint.dst)}` });
      if (hint.futureBuys && hint.futureBuys.length > 0) {
        steps.push({ icon: GiCargoCrate, text: `Buy ${itemList(hint.futureBuys)}` });
        steps.push({ icon: GiPathDistance, text: "Return and deliver" });
      } else {
        steps.push({ icon: GiTrade, text: "Sell or deliver cargo" });
      }
      return {
        label,
        meta: `Ç${Math.round(hint.expectedNet).toLocaleString()} · ${hint.ticks}t`,
        tone: "",
        steps,
      };
    }
    case "job_plan": {
      const steps: PlanStep[] = [];
      if (hint.acceptJobIds.length > 0) steps.push({ icon: GiContract, text: `Accept ${contractText(hint.acceptJobIds.length)}` });
      steps.push({ icon: GiTrade, text: `Sell ${itemList(hint.sells)} here` });
      return {
        label,
        meta: `Ç${Math.round(hint.expectedNet).toLocaleString()} · ${hint.ticks}t`,
        tone: "",
        steps,
      };
    }
    case "wait":
      return {
        label,
        meta: "waiting",
        tone: "warn",
        steps: [{ icon: GiRadarSweep, text: hint.reason, tone: "warn" }],
      };
    default:
      return {
        label,
        meta: "",
        tone: "",
        steps: [{ icon: GiRadarSweep, text: hintText }],
      };
  }
}

function FuelPanel({ ship, world, target, hintText, critical, inTransit }: {
  ship: Trader; world: World; target: HintTarget; hintText: string; critical: boolean; inTransit: boolean;
}) {
  const refuel = useStore((s) => s.refuel);
  const manualActions = ship.pilot !== "auto";
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
    : !manualActions
      ? <span className="ship-fuel-badge">Auto</span>
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

function targetBuyGoods(target: HintTarget): GoodId[] {
  const goods = new Set<GoodId>();
  if (target.buyGood) goods.add(target.buyGood);
  for (const good of Object.keys(target.buyGoods ?? {}) as GoodId[]) goods.add(good);
  return [...goods];
}

function targetSuggestsUpgradeBuy(target: HintTarget): boolean {
  return targetBuyGoods(target).some(isUpgradeGood);
}

function targetSuggestsMarketAction(target: HintTarget): boolean {
  return targetBuyGoods(target).some(good => !isUpgradeGood(good));
}

function targetSuggestsContracts(target: HintTarget): boolean {
  return target.acceptJobId != null || (target.acceptJobIds?.length ?? 0) > 0;
}

function targetSuggestsCargoAction(target: HintTarget): boolean {
  return [target.sellGood, ...(target.sellGoods ?? [])]
    .filter((good): good is GoodId => good != null)
    .some(good => !isUpgradeGood(good));
}

function StationExchangeCard({ ship, world, loc, target, hintText, selectedGood, onSelectGood, onHoverGood }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  target: HintTarget;
  hintText: string;
  selectedGood: GoodId | null;
  onSelectGood: (good: GoodId) => void;
  onHoverGood: (good: GoodId | null) => void;
}) {
  const [tab, setTab] = useState<"markets" | "upgrades" | "offers" | "contracts">("markets");
  const market = world.markets[loc.id];
  const offers = listHiresAt(world, ship.location);
  const marketGoodsCount = Object.keys(world.goods).filter(gid =>
    !isUpgradeGood(gid)
    && ((market.stock[gid] ?? 0) > 0.001 || findCargoLot(ship, gid) != null)
  ).length;
  const upgradeCount = Object.keys(world.goods).filter(gid => isUpgradeGood(gid) && (market.stock[gid] ?? 0) >= 1).length;
  const contractCount = Object.values(world.jobs).filter(j =>
    j.acceptedBy === ship.id || (j.acceptedBy == null && j.destination === loc.id)
  ).length;
  const marketsSuggested = targetSuggestsMarketAction(target);
  const upgradesSuggested = targetSuggestsUpgradeBuy(target);
  const contractsSuggested = targetSuggestsContracts(target);

  return (
    <section className="bridge-card market-card exchange-card">
      <header className="bridge-card-head">
        <div className="bridge-card-tabs">
          <button className={`bridge-tab ${tab === "markets" ? "active" : ""} ${marketsSuggested ? "has-suggestion" : ""}`} onClick={() => setTab("markets")}>
            <IconLabel icon={GiTrade}>Markets</IconLabel> <span className="bridge-tab-count">{marketGoodsCount}</span>
          </button>
          <button className={`bridge-tab ${tab === "upgrades" ? "active" : ""} ${upgradesSuggested ? "has-suggestion" : ""}`} onClick={() => setTab("upgrades")}>
            <IconLabel icon={GiAutoRepair}>Upgrades</IconLabel> <span className="bridge-tab-count">{upgradeCount}</span>
          </button>
          <button className={`bridge-tab ${tab === "offers" ? "active" : ""}`} onClick={() => setTab("offers")}>
            <IconLabel icon={GiAstronautHelmet}>Offers</IconLabel> <span className="bridge-tab-count">{offers.length}</span>
          </button>
          <button className={`bridge-tab ${tab === "contracts" ? "active" : ""} ${contractsSuggested ? "has-suggestion" : ""}`} onClick={() => setTab("contracts")}>
            <IconLabel icon={GiContract}>Contracts</IconLabel> <span className="bridge-tab-count">{contractCount}</span>
          </button>
        </div>
      </header>
      {tab === "markets" && (
        <MarketTableBody
          ship={ship}
          world={world}
          loc={loc}
          target={target}
          hintText={hintText}
          selectedGood={selectedGood}
          onSelectGood={onSelectGood}
          onHoverGood={onHoverGood}
        />
      )}
      {tab === "upgrades" && <StationUpgradePurchaseTab ship={ship} world={world} target={target} hintText={hintText} />}
      {tab === "offers" && <HireOffersTab ship={ship} world={world} />}
      {tab === "contracts" && <ContractsTab ship={ship} world={world} loc={loc} target={target} hintText={hintText} />}
    </section>
  );
}

function MarketTableBody({ ship, world, loc, target, hintText, selectedGood, onSelectGood, onHoverGood }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  target: HintTarget;
  hintText: string;
  selectedGood: GoodId | null;
  onSelectGood: (good: GoodId) => void;
  onHoverGood: (good: GoodId | null) => void;
}) {
  const buy = useStore((s) => s.buy);
  const manualActions = ship.pilot !== "auto";
  const market = world.markets[loc.id];
  const goodsOrdered = (Object.keys(world.goods) as GoodId[]).filter((gid) =>
    !isUpgradeGood(gid) && ((market.stock[gid] ?? 0) > 0.001 || findCargoLot(ship, gid) != null)
  );
  const suggestedBuyCount = Object.keys(target.buyGoods ?? {}).length;
  const buyOptionSet = suggestedBuyCount > 1;
  const buyHintLabel = buyOptionSet ? "Option set" : "Suggested";
  const currentMass = cargoMassFn(ship, world);

  return (
    <>
      <table className={`market-table ${!manualActions ? "market-table-readonly" : ""}`}>
        <colgroup>
          <col className="col-good" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-net-sell" />
          {manualActions && <col className="col-action" />}
        </colgroup>
        <thead>
          <tr>
            <th>Good</th>
            <th className="numeric">Stock</th>
            <th className="numeric">Price</th>
            <th className="numeric">Net Sell*</th>
            {manualActions && <th>Action</th>}
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
            const suggestedBuyQty = target.buyGoods?.[gid] ?? (target.buyGood === gid ? target.buyQty : undefined);
            const isBuyTarget = suggestedBuyQty != null;
            const isSelected = selectedGood === gid;
            const rowClass = `${isBuyTarget ? "row-suggested" : isCargo ? "row-mine" : ""} ${isSelected ? "row-selected" : ""}`;

            return (
              <tr
                key={gid}
                className={rowClass}
                tabIndex={0}
                onMouseEnter={() => onHoverGood(gid)}
                onMouseLeave={() => onHoverGood(null)}
                onFocus={() => onHoverGood(gid)}
                onBlur={() => onHoverGood(null)}
                onClick={() => onSelectGood(gid)}
              >
                <td>
                  <span className="good-name">{world.goods[gid].name}</span>
                  {isCargo && <span className="dim mono"> · holding {cargoQty.toFixed(0)}</span>}
                  {isFuel && <span className="faint"> · fuel</span>}
                  {isBuyTarget && buyOptionSet && <span className="suggestion-kind-tag">option</span>}
                </td>
                <td className="numeric mono">{stock.toFixed(0)}</td>
                <td className="numeric mono">Ç{price.toFixed(1)}</td>
                <td className="numeric mono dim">Ç{netSell.toFixed(1)}</td>
                {manualActions && (
                  <td>
                    <BuyControls
                      ship={ship}
                      world={world}
                      goodId={gid}
                      stock={stock}
                      price={price}
                      suggestedBuy={isBuyTarget}
                      hintText={hintText}
                      suggestionLabel={buyHintLabel}
                      recommendedBuyQty={suggestedBuyQty}
                      onBuy={(qty) => buy(ship.id, gid, qty)}
                    />
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
      {buyOptionSet && (
        <div className="market-option-note">
          <span className="option-note-label">Option set</span>
          <span className="dim">Highlighted buys compete for the same hold: {currentMass.toFixed(0)}/{ship.capacity} mass loaded.</span>
        </div>
      )}
      <div className="market-footnote faint">
        * Net Sell = listed price minus 15% port tax. What you'd actually receive if you sold here.
      </div>
    </>
  );
}

function BuyControls({
  ship, world, goodId, stock, price, suggestedBuy, hintText, suggestionLabel, recommendedBuyQty, onBuy,
}: {
  ship: Trader; world: World; goodId: string; stock: number; price: number;
  suggestedBuy: boolean; hintText: string;
  suggestionLabel?: string;
  recommendedBuyQty?: number;
  onBuy: (qty: number) => void;
}) {
  const good = world.goods[goodId];
  const totalMass = cargoMassFn(ship, world);
  const roomMass = ship.capacity - totalMass;
  const maxByRoom = Math.floor(roomMass / good.weight);
  const maxByFunds = price > 0 ? Math.floor(ship.funds / price) : 0;
  const maxBuy = Math.max(0, Math.min(maxByRoom, maxByFunds, Math.floor(stock)));

  const canBuy10 = maxBuy >= 10;
  const canBuyMax = maxBuy >= 1;

  let buyTitle = "";
  if (stock < 1) buyTitle = "Out of stock here";
  else if (maxByRoom < 1) buyTitle = "Cargo bay full";
  else if (maxByFunds < 1) buyTitle = "Insufficient funds";

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
      <ActionCell suggested={suggestedBuy} hintText={hintText} label={suggestionLabel}>
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
    </div>
  );
}

function travelCostEstimate(world: World, ship: Trader, from: LocationId, dist: number): number {
  const currentFuelGood = ship.currentFuel?.good ?? ship.fuelTypes[0]?.good;
  const fuelType = ship.fuelTypes.find(f => f.good === currentFuelGood) ?? ship.fuelTypes[0];
  const fuelPrice = fuelType ? world.markets[from].prices[fuelType.good] ?? 0 : 0;
  const fuelCost = fuelType ? dist * effectivePerDistance(ship, fuelType.perDistance) * fuelPrice : 0;
  const ticks = Math.max(1, Math.ceil(dist / ship.speed));
  return fuelCost + ticks * ship.capacity * MAINTENANCE_PER_CAPACITY + ship.capacity * DOCKING_FEE_PER_CAPACITY;
}

interface NearbyMarketSignal {
  to: LocationId;
  name: string;
  dist: number;
  price: number;
  netSell: number;
  stock: number;
  targetStock: number;
  demandGap: number;
  produced: number;
  consumed: number;
  transportCost: number;
  unitSpread: number;
  netAtQty: number;
  breakEvenQty: number | null;
}

function nearbyMarketSignals(world: World, ship: Trader, from: LocationId, goodId: GoodId, qty: number, unitCost: number): NearbyMarketSignal[] {
  return reachableNeighbors(world, from)
    .map(({ to, dist }) => {
      const dst = world.locations[to];
      const market = world.markets[to];
      const price = market.prices[goodId] ?? world.goods[goodId]?.basePrice ?? 0;
      const netSell = price * (1 - SALES_TAX_RATE);
      const stock = market.stock[goodId] ?? 0;
      const targetStock = dst.targetStock[goodId] ?? 0;
      const produced = dst.produces.find(p => p.good === goodId)?.ratePerTick ?? 0;
      const consumed = dst.consumes.find(c => c.good === goodId)?.ratePerTick ?? 0;
      const demandGap = Math.max(0, targetStock - stock);
      const transportCost = travelCostEstimate(world, ship, from, dist);
      const unitSpread = netSell - unitCost;
      const netAtQty = unitSpread * qty - transportCost;
      const breakEvenQty = unitSpread > 0 ? Math.ceil(transportCost / unitSpread) : null;
      return {
        to,
        name: dst.name,
        dist,
        price,
        netSell,
        stock,
        targetStock,
        demandGap,
        produced,
        consumed,
        transportCost,
        unitSpread,
        netAtQty,
        breakEvenQty,
      };
    })
    .sort((a, b) => a.dist - b.dist);
}

function bestCargoExitForGood(world: World, ship: Trader, from: LocationId, goodId: GoodId, cargo: CargoGroup): { to: LocationId; pnl: number } | null {
  let best: { to: LocationId; pnl: number } | null = null;

  for (const { to, dist } of reachableNeighbors(world, from)) {
    const sellNet = (world.markets[to].prices[goodId] ?? 0) * (1 - SALES_TAX_RATE);
    const pnl = cargo.totalQty * sellNet - cargo.totalCost - travelCostEstimate(world, ship, from, dist);
    if (!best || pnl > best.pnl) best = { to, pnl };
  }

  return best;
}

function suggestedTradeFocus(target: HintTarget): TradeHelperFocus | null {
  if (target.sellGood && !isUpgradeGood(target.sellGood)) return { good: target.sellGood, source: "cargo" };
  const sellGood = target.sellGoods?.find(good => !isUpgradeGood(good));
  if (sellGood) return { good: sellGood, source: "cargo" };
  const buyGood = targetBuyGoods(target).find(good => !isUpgradeGood(good));
  return buyGood ? { good: buyGood, source: "market" } : null;
}

function TradeHelperCard({ ship, world, loc, focus, target, hint }: {
  ship: Trader; world: World; loc: LocationDef; focus: TradeHelperFocus | null; target: HintTarget; hint: GuidedHint;
}) {
  const market = world.markets[loc.id];
  const cargoGroups = groupCargoByGood(ship);
  const selectedFocus = focus && world.goods[focus.good] && !isUpgradeGood(focus.good) ? focus : null;
  const firstVisibleGood = (Object.keys(world.goods) as GoodId[]).find(gid =>
    !isUpgradeGood(gid) && ((market.stock[gid] ?? 0) > 0.001 || cargoGroups.some(g => g.good === gid))
  );
  const fallbackFocus = selectedFocus
    ?? suggestedTradeFocus(target)
    ?? (firstVisibleGood ? { good: firstVisibleGood, source: "market" as const } : null);
  const fallbackGood = fallbackFocus?.good ?? null;

  if (!fallbackGood) {
    return (
      <section className="bridge-card trade-helper-card">
        <header className="bridge-card-head">
          <SingleTabHeader label="Trade helper" icon={GiTrade} />
        </header>
        <div className="trade-helper-empty">Select a market row to inspect routes, stock, and contracts.</div>
      </section>
    );
  }

  const good = world.goods[fallbackGood];
  const stock = market.stock[fallbackGood] ?? 0;
  const price = market.prices[fallbackGood] ?? good.basePrice;
  const targetStock = loc.targetStock[fallbackGood] ?? 0;
  const stockPct = targetStock > 0 ? Math.max(0, Math.min(100, (stock / targetStock) * 100)) : 0;
  const stockTone = targetStock > 0 && stock < targetStock * 0.35 ? "warn" : targetStock > 0 && stock > targetStock * 1.2 ? "good" : "";
  const cargo = cargoGroups.find(g => g.good === fallbackGood) ?? null;
  const cargoFocused = fallbackFocus?.source === "cargo" && cargo != null;
  const ageTicks = cargo ? world.tick - cargo.oldestPurchasedAt : 0;
  const totalMass = cargoMassFn(ship, world);
  const roomMass = Math.max(0, ship.capacity - totalMass);
  const maxByRoom = Math.floor(roomMass / good.weight);
  const maxByFunds = price > 0 ? Math.floor(ship.funds / price) : 0;
  const maxBuy = Math.max(0, Math.min(maxByRoom, maxByFunds, Math.floor(stock)));
  const hereNet = price * (1 - SALES_TAX_RATE);
  const routeQty = cargoFocused ? cargo.totalQty : maxBuy;
  const routeUnitCost = cargoFocused ? cargo.weightedAvgPrice : price;
  const produced = loc.produces.find(p => p.good === fallbackGood)?.ratePerTick ?? 0;
  const consumed = loc.consumes.find(c => c.good === fallbackGood)?.ratePerTick ?? 0;
  const cargoPnl = cargo ? cargo.totalQty * hereNet - cargo.totalCost : 0;
  const localSellSignal: NearbyMarketSignal | null = cargoFocused ? {
    to: loc.id,
    name: `${loc.name} (here)`,
    dist: 0,
    price,
    netSell: hereNet,
    stock,
    targetStock,
    demandGap: Math.max(0, targetStock - stock),
    produced,
    consumed,
    transportCost: 0,
    unitSpread: hereNet - routeUnitCost,
    netAtQty: cargoPnl,
    breakEvenQty: null,
  } : null;
  const nearbyMarkets = nearbyMarketSignals(world, ship, loc.id, fallbackGood, routeQty, routeUnitCost);
  const suggestedSellHere = hint.kind === "sell_here" && hint.good === fallbackGood && localSellSignal != null;
  const suggestedTravelSell = hint.kind === "travel_to_sell" && hint.good === fallbackGood;
  const suggestedSellRoute = suggestedSellHere
    ? localSellSignal
    : suggestedTravelSell
      ? nearbyMarkets.find(row => row.to === hint.dst) ?? null
      : null;
  const coveredRoute = suggestedSellRoute ?? (routeQty > 0
    ? [...nearbyMarkets].filter(row => row.netAtQty > 0).sort((a, b) => b.netAtQty - a.netAtQty)[0] ?? null
    : null);
  const breakEvenRoute = [...nearbyMarkets]
    .filter(row => row.breakEvenQty != null)
    .sort((a, b) => (a.breakEvenQty ?? 0) - (b.breakEvenQty ?? 0) || b.unitSpread - a.unitSpread)[0] ?? null;
  const demandRows = localSellSignal ? [localSellSignal, ...nearbyMarkets] : nearbyMarkets;
  const nearestDemand = demandRows
    .filter(row => row.demandGap >= 1 || row.consumed > row.produced)
    .sort((a, b) => a.dist - b.dist || b.demandGap - a.demandGap)[0] ?? null;
  const bestNearbySell = [...nearbyMarkets].sort((a, b) => b.netSell - a.netSell)[0] ?? null;
  const orderRows = localSellSignal ? [localSellSignal, ...nearbyMarkets].slice(0, 6) : nearbyMarkets.slice(0, 6);
  const priceDeltaReference = cargoFocused ? cargo.weightedAvgPrice : hereNet;
  const bestNearbyDelta = bestNearbySell ? bestNearbySell.netSell - priceDeltaReference : 0;
  const bestNearbyIsSuggested = bestNearbySell != null && suggestedSellRoute != null && bestNearbySell.to === suggestedSellRoute.to;
  const bestNearbyPriceTone = bestNearbySell && routeQty > 0 && bestNearbySell.netAtQty > 0 && (!suggestedSellRoute || bestNearbyIsSuggested)
    ? "good"
    : bestNearbyDelta > 0
      ? "warn"
      : "";
  const orderBookContext = cargoFocused
    ? `Profit/loss uses your held ${cargo.totalQty.toFixed(0)}u, weighted cost basis, fuel, maintenance, and docking.`
    : maxBuy > 0
      ? `Profit/loss uses max buy ${maxBuy.toLocaleString()}u after fuel, maintenance, and docking.`
    : "Profit/loss shows break-even quantity when you cannot buy here.";
  const bestCargo = cargo ? bestCargoExitForGood(world, ship, loc.id, fallbackGood, cargo) : null;
  const relatedContracts = Object.values(world.jobs)
    .filter(j => j.good === fallbackGood && (j.acceptedBy === ship.id || (j.acceptedBy == null && j.destination === loc.id)))
    .sort(localJobSort)
    .slice(0, 4);
  const isSuggested = target.buyGood === fallbackGood
    || target.sellGood === fallbackGood
    || target.buyGoods?.[fallbackGood] != null
    || target.sellGoods?.includes(fallbackGood) === true;
  const lotRows = cargo ? [...cargo.lots].sort((a, b) => a.purchasedAt - b.purchasedAt).slice(0, 4) : [];

  return (
    <section className="bridge-card trade-helper-card">
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow station-eyebrow">Trade helper</span>
          <span className="trade-helper-good">{good.name}</span>
        </div>
        {isSuggested && <span className="trade-helper-suggested">suggested</span>}
      </header>

      <div className="trade-helper-meta">
        <span>{good.category}</span>
        <span>{good.weight.toFixed(1)} mass/u</span>
        <span>{cargoFocused ? "cargo lot" : hint.kind.replace(/_/g, " ")}</span>
      </div>

      <div className="trade-helper-stock">
        <div className="trade-helper-stock-head">
          <span>Station stock</span>
          <span className="mono">{stock.toFixed(0)} / {targetStock > 0 ? targetStock.toFixed(0) : "no target"}</span>
        </div>
        <div className="trade-helper-bar">
          <div className={`trade-helper-bar-fill ${stockTone}`} style={{ width: `${targetStock > 0 ? stockPct : Math.min(100, stock)}%` }} />
        </div>
      </div>

      <dl className="trade-helper-grid">
        {cargoFocused ? (
          <>
            <Stat label="holding" value={`${cargo.totalQty.toFixed(0)}u`} />
            <Stat label="avg paid" value={`Ç${cargo.weightedAvgPrice.toFixed(1)}`} />
            <Stat label="cost basis" value={`Ç${Math.round(cargo.totalCost).toLocaleString()}`} />
            <Stat label="oldest lot" value={`${ageTicks}t`} />
            <Stat label="local net" value={`Ç${hereNet.toFixed(1)}/u`} />
            <Stat label="sell here" value={`${cargoPnl >= 0 ? "+" : ""}Ç${Math.round(cargoPnl).toLocaleString()}`} />
          </>
        ) : (
          <>
            <Stat label="buy price" value={`Ç${price.toFixed(1)}`} />
            <Stat label="net sell" value={`Ç${hereNet.toFixed(1)}`} />
            <Stat label="max buy" value={maxBuy.toLocaleString()} />
            <Stat label="holding" value={cargo ? cargo.totalQty.toFixed(0) : "none"} />
            <Stat label="avg paid" value={cargo ? `Ç${cargo.weightedAvgPrice.toFixed(1)}` : "—"} />
            <Stat label="sell here" value={cargo ? `${cargoPnl >= 0 ? "+" : ""}Ç${Math.round(cargoPnl).toLocaleString()}` : "—"} />
          </>
        )}
      </dl>

      {cargoFocused && (
        <div className="trade-helper-section">
          <div className="exchange-section-title">Cargo history</div>
          <div className="trade-helper-line">
            <span>Sources</span>
            <span>{[...cargo.sources].map(source => world.locations[source]?.name ?? source).join(", ")}</span>
          </div>
          <table className="trade-helper-market-table trade-helper-lot-table">
            <thead>
              <tr>
                <th>From</th>
                <th className="numeric">Qty</th>
                <th className="numeric">Paid</th>
                <th className="numeric">Age</th>
              </tr>
            </thead>
            <tbody>
              {lotRows.map((lot, i) => (
                <tr key={`${lot.source}-${lot.purchasedAt}-${i}`}>
                  <td title={world.locations[lot.source]?.name ?? lot.source}>{world.locations[lot.source]?.name ?? lot.source}</td>
                  <td className="numeric mono">{lot.qty.toFixed(0)}</td>
                  <td className="numeric mono">Ç{lot.unitPrice.toFixed(1)}</td>
                  <td className="numeric mono">{world.tick - lot.purchasedAt}t</td>
                </tr>
              ))}
            </tbody>
          </table>
          {cargo.lots.length > lotRows.length && (
            <div className="trade-helper-note">+{cargo.lots.length - lotRows.length} older lot{cargo.lots.length - lotRows.length === 1 ? "" : "s"} folded into the weighted average.</div>
          )}
        </div>
      )}

      <div className="trade-helper-section">
        <div className="exchange-section-title">Market signals</div>
        <div className="trade-helper-line">
          <span>Nearest demand</span>
          {nearestDemand
            ? <span>{nearestDemand.name} · {nearestDemand.dist.toFixed(1)}u · gap {nearestDemand.demandGap.toFixed(0)} · Ç{nearestDemand.price.toFixed(1)}</span>
            : <span className="dim">No nearby demand gap</span>}
        </div>
        <div className="trade-helper-line">
          <span>{cargoFocused ? "Best remote price" : "Best unit price"}</span>
          {bestNearbySell
            ? <span className={bestNearbyPriceTone}>{bestNearbySell.name} · net Ç{bestNearbySell.netSell.toFixed(1)} ({bestNearbyDelta >= 0 ? "+" : ""}{bestNearbyDelta.toFixed(1)}/u {cargoFocused ? "vs paid" : "before travel"})</span>
            : <span className="dim">No reachable market data</span>}
        </div>
        <div className="trade-helper-line">
          <span>{suggestedSellRoute ? "Suggested sell" : "Route profit/loss"}</span>
          {coveredRoute
            ? (
              <span className={coveredRoute.netAtQty > 0 ? "good" : coveredRoute.netAtQty < 0 ? "bad" : ""}>
                {suggestedSellHere
                  ? `Sell here now · ${coveredRoute.netAtQty >= 0 ? "+" : ""}Ç${Math.round(coveredRoute.netAtQty).toLocaleString()}`
                  : `${coveredRoute.name} · ${coveredRoute.netAtQty >= 0 ? "+" : ""}Ç${Math.round(coveredRoute.netAtQty).toLocaleString()} @ ${routeQty.toLocaleString()}u after Ç${Math.round(coveredRoute.transportCost).toLocaleString()}`}
              </span>
            )
            : breakEvenRoute && breakEvenRoute.breakEvenQty != null
              ? <span className="warn">No covered route; need {breakEvenRoute.breakEvenQty.toLocaleString()}u for {breakEvenRoute.name}, {cargoFocused ? "holding" : "max"} {routeQty.toLocaleString()}</span>
              : <span className="dim">No positive nearby spread</span>}
        </div>
        <div className="trade-helper-line">
          <span>{suggestedSellRoute ? "Best remote exit" : "Cargo exit"}</span>
          {bestCargo
            ? <span className={bestCargo.pnl > 0 ? "good" : bestCargo.pnl < 0 ? "bad" : ""}>{world.locations[bestCargo.to]?.name ?? bestCargo.to} · {bestCargo.pnl >= 0 ? "+" : ""}Ç{Math.round(bestCargo.pnl).toLocaleString()}</span>
            : <span className="dim">No matching cargo loaded</span>}
        </div>
      </div>

      <div className="trade-helper-section">
        <div className="exchange-section-title">Nearby order book</div>
        <div className="trade-helper-note">{orderBookContext}</div>
        {orderRows.length === 0 ? (
          <div className="trade-helper-line muted"><span>Routes</span><span>No reachable stations</span></div>
        ) : (
          <table className="trade-helper-market-table">
            <thead>
              <tr>
                <th>Station</th>
                <th className="numeric">Dist</th>
                <th className="numeric">Sell</th>
                <th className="numeric">Demand</th>
                <th className="numeric">Profit/loss</th>
              </tr>
            </thead>
            <tbody>
              {orderRows.map(row => {
                const demandText = row.demandGap >= 1
                  ? row.demandGap.toFixed(0)
                  : row.consumed > row.produced
                    ? "flow"
                    : "—";
                const routeTone = routeQty > 0 && row.netAtQty > 0 ? "good" : routeQty > 0 && row.netAtQty < 0 ? "bad" : "";
                const routeText = routeQty > 0
                  ? `${row.netAtQty >= 0 ? "+" : ""}Ç${Math.round(row.netAtQty).toLocaleString()}`
                  : row.breakEvenQty != null
                    ? `${row.breakEvenQty.toLocaleString()}u`
                    : "—";
                return (
                  <tr key={row.to}>
                    <td title={row.name}>{row.name}</td>
                    <td className="numeric mono">{row.dist.toFixed(1)}</td>
                    <td className="numeric mono">Ç{row.netSell.toFixed(1)}</td>
                    <td className="numeric mono">{demandText}</td>
                    <td className={`numeric mono ${routeTone}`}>{routeText}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <div className="trade-helper-section">
        <div className="exchange-section-title">Station flow</div>
        <div className="trade-helper-flow">
          <span>produces {produced.toFixed(1)}/t</span>
          <span>consumes {consumed.toFixed(1)}/t</span>
        </div>
      </div>

      <div className="trade-helper-section">
        <div className="exchange-section-title">Related contracts</div>
        {relatedContracts.length === 0 ? (
          <div className="trade-helper-line muted"><span>Open work</span><span>None here</span></div>
        ) : (
          <div className="trade-helper-contracts">
            {relatedContracts.map(job => (
              <span key={job.id} className={`trade-helper-contract tier-${job.tier}`}>
                {job.acceptedBy === ship.id ? "active" : job.tier} · {Math.max(0, job.qty - job.delivered).toFixed(0)} to {world.locations[job.destination]?.name ?? job.destination}
              </span>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function CargoBridgeCard({ ship, world, loc, inTransit, target, hintText, selectedGood, onSelectGood, onHoverGood }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  inTransit: boolean;
  target: HintTarget;
  hintText: string;
  selectedGood: GoodId | null;
  onSelectGood: (good: GoodId) => void;
  onHoverGood: (good: GoodId | null) => void;
}) {
  const [tab, setTab] = useState<"cargo" | "upgrades" | "crew">("cargo");
  const groups = groupCargoByGood(ship);
  const installedCount = Object.keys(ship.upgrades ?? {}).length;
  const cargoSuggested = targetSuggestsCargoAction(target);

  return (
    <section className="bridge-card cargo-bridge-card">
      <header className="bridge-card-head">
        <div className="bridge-card-tabs">
          <button
            className={`bridge-tab ${tab === "cargo" ? "active" : ""} ${cargoSuggested ? "has-suggestion" : ""}`}
            onClick={() => setTab("cargo")}
          >
            <IconLabel icon={GiCargoCrate}>Cargo</IconLabel> {ship.cargo.length > 0 && <span className="bridge-tab-count">{ship.cargo.length}</span>}
          </button>
          <button
            className={`bridge-tab ${tab === "upgrades" ? "active" : ""}`}
            onClick={() => setTab("upgrades")}
          >
            <IconLabel icon={GiAutoRepair}>Upgrades</IconLabel> <span className="bridge-tab-count">{installedCount}/5</span>
          </button>
          <button
            className={`bridge-tab ${tab === "crew" ? "active" : ""}`}
            onClick={() => setTab("crew")}
          >
            <IconLabel icon={GiAstronautHelmet}>Crew</IconLabel> <span className="bridge-tab-count">{Object.keys(ship.crew ?? {}).length}/3</span>
          </button>
        </div>
      </header>
      {tab === "cargo" && (
        <CargoTab
          ship={ship}
          world={world}
          loc={loc}
          groups={groups}
          inTransit={inTransit}
          target={target}
          hintText={hintText}
          selectedGood={selectedGood}
          onSelectGood={onSelectGood}
          onHoverGood={onHoverGood}
        />
      )}
      {tab === "upgrades" && <ShipUpgradesTab ship={ship} />}
      {tab === "crew" && <CrewTab ship={ship} />}
    </section>
  );
}

const UPGRADE_SLOT_RANK: Record<UpgradeSlot, number> = {
  cargo: 0,
  engine: 1,
  fuel: 2,
  hull: 3,
  weapon: 4,
};

const UPGRADE_SLOT_ICONS: Record<UpgradeSlot, IconType> = {
  cargo: GiCargoCrate,
  engine: GiSpeedometer,
  fuel: GiFuelTank,
  hull: GiAutoRepair,
  weapon: GiRadarSweep,
};

function compareUpgradeGoods(a: string, b: string): number {
  const da = upgradeDef(a);
  const db = upgradeDef(b);
  if (!da || !db) return a.localeCompare(b);
  return UPGRADE_SLOT_RANK[da.slot] - UPGRADE_SLOT_RANK[db.slot]
    || da.tier - db.tier
    || da.name.localeCompare(db.name);
}

function ShipUpgradesTab({ ship }: { ship: Trader }) {
  const installFromCargo = useStore((s) => s.installUpgradeFromCargo);
  const docked = ship.state === "idle";
  const cargoUpgrades = groupCargoByGood(ship)
    .filter(g => isUpgradeGood(g.good))
    .sort((a, b) => compareUpgradeGoods(a.good, b.good));

  return (
    <div className="upgrades-tab">
      <table className="upgrade-table upgrade-slots-table">
        <colgroup>
          <col className="col-role" />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>Slot</th>
            <th>Installed</th>
            <th>Effect</th>
          </tr>
        </thead>
        <tbody>
          {UPGRADE_SLOTS.map(({ slot, label }) => {
            const def = installedUpgrade(ship, slot);
            const Icon = UPGRADE_SLOT_ICONS[slot];
            return (
              <tr key={slot} className="upgrade-slot-row">
                <td className="dim"><IconLabel icon={Icon}>{label}</IconLabel></td>
                <td>
                  {def ? (
                    <>
                      <span className="upgrade-name">{def.name}</span>
                      <span className="upgrade-stars mono"> {upgradeStars(def.tier)}</span>
                    </>
                  ) : (
                    <span className="faint">open</span>
                  )}
                </td>
                <td className="dim">{def ? upgradeEffectText(def) : "No modifier"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="upgrade-offer-title dim">Cargo modules</div>
      <table className="upgrade-table upgrade-offers-table">
        <colgroup>
          <col className="col-source" />
          <col />
          <col className="col-role" />
          <col className="col-num" />
          <col className="col-action" />
        </colgroup>
        <thead>
          <tr>
            <th>Source</th>
            <th>Module</th>
            <th>Slot</th>
            <th className="numeric">Cost</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {cargoUpgrades.length === 0 ? (
            <tr>
              <td colSpan={5} className="upgrade-row-empty">
                No upgrade modules in cargo.
              </td>
            </tr>
          ) : (
            <>
              {cargoUpgrades.map((group) => {
                const def = upgradeDef(group.good)!;
                const Icon = UPGRADE_SLOT_ICONS[def.slot];
                const alreadyInstalled = ship.upgrades?.[def.slot] === def.id;
                const disabled = !docked || alreadyInstalled;
                const title = !docked
                  ? "Dock to install"
                  : alreadyInstalled
                    ? "Already installed"
                    : `Install ${def.name} from cargo`;
                return (
                  <tr key={`cargo-${group.good}`} className="upgrade-offer-row">
                    <td><span className="upgrade-source-pill">Cargo</span></td>
                    <td>
                      <span className="upgrade-name">{def.name}</span>
                      <span className="upgrade-stars mono"> {upgradeStars(def.tier)}</span>
                      <span className="dim"> · {upgradeEffectText(def)}</span>
                    </td>
                    <td className="dim"><IconLabel icon={Icon}>{UPGRADE_SLOTS.find(s => s.slot === def.slot)?.label ?? def.slot}</IconLabel></td>
                    <td className="numeric mono dim">x{group.totalQty.toFixed(0)}</td>
                    <td>
                      <button
                        className="btn-action upgrade-action"
                        onClick={() => installFromCargo(ship.id, def.id)}
                        disabled={disabled}
                        title={title}
                      >
                        <span className="btn-label">Install</span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </>
          )}
        </tbody>
      </table>
    </div>
  );
}

function StationUpgradePurchaseTab({ ship, world, target, hintText }: {
  ship: Trader; world: World; target: HintTarget; hintText: string;
}) {
  const buy = useStore((s) => s.buy);
  const docked = ship.state === "idle";
  const market = docked ? world.markets[ship.location] : null;
  const stationUpgradeIds = market
    ? Object.keys(world.goods)
      .filter(g => isUpgradeGood(g) && (market.stock[g] ?? 0) >= 1)
      .sort(compareUpgradeGoods)
    : [];
  const totalMass = cargoMassFn(ship, world);
  const roomMass = ship.capacity - totalMass;
  const suggestedBuyCount = Object.keys(target.buyGoods ?? {}).length;
  const suggestionLabel = suggestedBuyCount > 1 ? "Option set" : "Suggested";

  return (
    <div className="upgrades-tab">
      <div className="upgrade-offer-title dim">Station upgrades</div>
      <table className="upgrade-table upgrade-offers-table">
        <colgroup>
          <col />
          <col className="col-role" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-action" />
        </colgroup>
        <thead>
          <tr>
            <th>Module</th>
            <th>Slot</th>
            <th className="numeric">Stock</th>
            <th className="numeric">Cost</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {stationUpgradeIds.length === 0 ? (
            <tr>
              <td colSpan={5} className="upgrade-row-empty">
                {docked ? "No upgrade modules stocked at this station." : "Dock to browse station upgrades."}
              </td>
            </tr>
          ) : (
            stationUpgradeIds.map((goodId) => {
              const def = upgradeDef(goodId)!;
              const Icon = UPGRADE_SLOT_ICONS[def.slot];
              const good = world.goods[goodId];
              const price = market?.prices[goodId] ?? good.basePrice;
              const stock = market?.stock[goodId] ?? 0;
              const canAfford = ship.funds >= price;
              const fits = roomMass >= good.weight;
              const disabled = !docked || !canAfford || stock < 1 || !fits;
              const suggested = target.buyGood === goodId || target.buyGoods?.[goodId] != null;
              const title = !docked
                ? "Dock to buy"
                : stock < 1
                  ? "Out of stock here"
                  : !fits
                    ? "Cargo bay full"
                    : !canAfford
                      ? "Insufficient funds"
                      : `Buy ${def.name} into cargo`;
              return (
                <tr key={goodId} className={`upgrade-offer-row ${suggested ? "row-suggested" : ""}`}>
                  <td>
                    <span className="upgrade-name">{def.name}</span>
                    <span className="upgrade-stars mono"> {upgradeStars(def.tier)}</span>
                    <span className="dim"> · {upgradeEffectText(def)}</span>
                  </td>
                  <td className="dim"><IconLabel icon={Icon}>{UPGRADE_SLOTS.find(s => s.slot === def.slot)?.label ?? def.slot}</IconLabel></td>
                  <td className="numeric mono">{stock.toFixed(0)}</td>
                  <td className="numeric mono">Ç{Math.round(price).toLocaleString()}</td>
                  <td>
                    <ActionCell suggested={suggested} hintText={hintText} label={suggestionLabel}>
                      <button
                        className={`btn-action upgrade-action ${suggested ? "btn-suggested" : "primary"}`}
                        onClick={() => buy(ship.id, goodId, 1)}
                        disabled={disabled}
                        title={title}
                      >
                        <span className="btn-label">Buy</span>
                      </button>
                    </ActionCell>
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function CargoTab({ ship, world, loc, groups, inTransit, target, hintText, selectedGood, onSelectGood, onHoverGood }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  groups: CargoGroup[];
  inTransit: boolean;
  target: HintTarget;
  hintText: string;
  selectedGood: GoodId | null;
  onSelectGood: (good: GoodId) => void;
  onHoverGood: (good: GoodId | null) => void;
}) {
  const sell = useStore((s) => s.sell);
  const manualActions = ship.pilot !== "auto";

  return (
    <table className="cargo-table">
      <colgroup>
        <col />
        <col className="col-num" />
        <col className="cargo-col-pnl" />
        {manualActions && <col className="cargo-col-action" />}
      </colgroup>
      <thead>
        <tr>
          <th>Good</th>
          <th className="numeric">Qty</th>
          <th className="numeric">P&amp;L <span className="dim">({inTransit ? "on arrival" : "here"})</span></th>
          {manualActions && <th>Action</th>}
        </tr>
      </thead>
      <tbody>
        {groups.length === 0 ? (
          <tr><td colSpan={manualActions ? 4 : 3} className="cargo-row-empty">Cargo bay empty</td></tr>
        ) : (
          groups.map((g) => (
            <CargoRow
              key={g.good}
              group={g}
              ship={ship}
              world={world}
              refLocId={loc.id}
              inTransit={inTransit}
              suggested={target.sellGood === g.good || target.sellGoods?.includes(g.good) === true}
              hintText={hintText}
              selected={selectedGood === g.good}
              showAction={manualActions}
              onSelect={() => onSelectGood(g.good)}
              onHover={(good) => onHoverGood(good)}
              onSell={() => sell(ship.id, g.good, g.totalQty)}
            />
          ))
        )}
      </tbody>
    </table>
  );
}

function CargoRow({ group, ship, world, refLocId, inTransit, suggested, hintText, selected, showAction, onSelect, onHover, onSell }: {
  group: CargoGroup;
  ship: Trader;
  world: World;
  refLocId: string;
  inTransit: boolean;
  suggested: boolean;
  hintText: string;
  selected: boolean;
  showAction: boolean;
  onSelect: () => void;
  onHover: (good: GoodId | null) => void;
  onSell: () => void;
}) {
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
  const canSell = ship.state === "idle" && group.totalQty > 0;

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
  const showTooltipAndHelper = () => {
    tooltipHandlers.onMouseEnter();
    onHover(group.good);
  };
  const hideTooltipAndHelper = () => {
    tooltipHandlers.onMouseLeave();
    onHover(null);
  };

  return (
    <>
      <tr
        className={`cargo-row ${suggested ? "row-suggested" : ""} ${selected ? "row-selected" : ""}`}
        ref={tooltipRef}
        tabIndex={0}
        onMouseEnter={showTooltipAndHelper}
        onMouseLeave={hideTooltipAndHelper}
        onFocus={() => onHover(group.good)}
        onBlur={() => onHover(null)}
        onClick={onSelect}
      >
        <td>
          <span className="cargo-row-name">{good.name}</span>
          {group.lots.length > 1 && <span className="cargo-row-lots dim mono"> ({group.lots.length}L)</span>}
        </td>
        <td className="numeric mono">{group.totalQty.toFixed(0)}</td>
        <td className={`numeric mono cargo-row-pnl ${pnlTone}`}>
          {pnl >= 0 ? "+" : ""}Ç{Math.round(pnl).toLocaleString()}
          <span className="dim"> ({pnl >= 0 ? "+" : ""}{pnlPct.toFixed(0)}%)</span>
        </td>
        {showAction && (
          <td>
            <ActionCell suggested={suggested} hintText={hintText}>
              <button
                className={`btn-action cargo-sell-action ${suggested ? "btn-suggested" : ""}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onSell();
                }}
                disabled={!canSell}
                title={canSell ? `Sell ${group.totalQty.toFixed(0)} ${good.name}` : inTransit ? "Dock to sell cargo" : "No cargo to sell"}
              >
                <span className="btn-label">Sell</span>
                <span className="btn-count">{group.totalQty.toFixed(0)}</span>
              </button>
            </ActionCell>
          </td>
        )}
      </tr>
      {tooltipPortal}
    </>
  );
}

const MOD_LABEL: Record<keyof CrewModifiers, (v: number) => string> = {
  cargoCapacityBonus:  (v) => `+${v} cargo`,
  fuelCapacityBonus:   (v) => `+${v} fuel`,
  speedBonus:          (v) => `+${v} speed`,
  hullBonus:           (v) => `+${v} hull`,
  weaponPowerBonus:    (v) => `+${v} weapons`,
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
  const manualActions = ship.pilot !== "auto";
  const ft = ship.fuelTypes.find(f => f.good === ship.currentFuel?.good);
  const fuel = ship.currentFuel?.qty ?? 0;
  const market = world.markets[ship.location];
  const activeJobsByDestination = new Map<string, Job[]>();
  for (const job of Object.values(world.jobs)) {
    if (job.acceptedBy !== ship.id) continue;
    const jobs = activeJobsByDestination.get(job.destination) ?? [];
    jobs.push(job);
    activeJobsByDestination.set(job.destination, jobs);
  }
  const contractLine = (jobs: Job[]) => {
    const first = jobs.slice(0, 2).map(j => `${world.goods[j.good]?.name ?? j.good} ${Math.max(0, j.qty - j.delivered).toFixed(0)}`);
    const more = jobs.length > 2 ? ` +${jobs.length - 2}` : "";
    return `${jobs.length} active: ${first.join(", ")}${more}`;
  };

  const dests = reachableNeighbors(world, ship.location)
    .map(({ to, dist }) => {
      const dst = world.locations[to];
      const fuelNeeded = ft ? dist * effectivePerDistance(ship, ft.perDistance) : 0;
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
      <table className={`travel-table ${!manualActions ? "travel-table-readonly" : ""}`}>
        <colgroup>
          <col className="col-dest" />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-num" />
          {manualActions && <col className="col-action" />}
        </colgroup>
        <thead>
          <tr>
            <th>To</th>
            <th className="numeric">Dist</th>
            <th className="numeric">Fuel</th>
            <th className="numeric">Time</th>
            {manualActions && <th></th>}
          </tr>
        </thead>
        <tbody>
          {dests.map((d) => {
            const suggested = target.travelTo === d.to;
            const destinationJobs = activeJobsByDestination.get(d.to) ?? [];
            const travelLabel = suggested ? target.travelLabel : undefined;
            return (
              <tr key={d.to} className={`${suggested ? "row-suggested" : ""} ${destinationJobs.length > 0 ? "travel-has-contract" : ""}`}>
                <td>
                  <div className="travel-dest-cell">
                    <span className="travel-dest-name">{d.name}</span>
                    {(travelLabel || destinationJobs.length > 0) && (
                      <span className="travel-contract-line">
                        {travelLabel && <span className="travel-contract-pill">{travelLabel}</span>}
                        {destinationJobs.length > 0 && <span>{contractLine(destinationJobs)}</span>}
                      </span>
                    )}
                  </div>
                </td>
                <td className="numeric mono">{d.dist.toFixed(1)}</td>
                <td className={`numeric mono ${d.canFly ? "" : "bad"}`}>{d.fuelNeeded.toFixed(1)}</td>
                <td className="numeric mono">{d.travelTicks}t</td>
                {manualActions && (
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
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
