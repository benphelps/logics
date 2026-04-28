import { useEffect, useRef, useState, type AnimationEvent, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { IconType } from "react-icons";
import { MdPushPin } from "react-icons/md";
import {
  GiAstronautHelmet,
  GiAutoRepair,
  GiCargoCrate,
  GiContract,
  GiFactory,
  GiFuelTank,
  GiPathDistance,
  GiRadarSweep,
  GiSpeedometer,
  GiTrade,
} from "react-icons/gi";
import { useStore } from "../store";
import { distance, reachableNeighbors } from "../../sim/geometry";
import { describeHint, getGuidedPlan, hintTarget, type GuidedHint, type GuidedPlan, type HintTarget } from "../../sim/suggestions";
import { DOCKING_FEE_PER_CAPACITY, MAINTENANCE_PER_CAPACITY, SALES_TAX_RATE } from "../../sim/economy";
import { marketQuote } from "../../sim/pricing";
import { cargoMass as cargoMassFn, findCargoLot, groupCargoByGood, type CargoGroup } from "../../sim/cargo";
import { listLocalJobs } from "../../sim/jobs";
import { effectivePerDistance, hasCrew, totalCrewWage } from "../../sim/crew";
import { MAINTENANCE_DEBT_TRAVEL_BLOCK } from "../../sim/crew";
import { listHiresAt } from "../../sim/hires";
import { selectRefuelType } from "../../sim/traders";
import { UPGRADE_SLOTS, installedUpgrade, isUpgradeGood, upgradeDef, upgradeEffectText } from "../../sim/upgrades";
import type { CrewModifiers, CrewRole } from "../../sim/types";
import type { GoodId, Job, JobId, LocationDef, LocationId, Trader, UpgradeSlot, World } from "../../sim/types";
import { goodArtUrl, shipArtUrl, stationArtUrl, stationKind, stationKindLabel, stationScale, stationScaleLabel, stationSubtype, stationSubtypeLabel } from "../art";
import "./PlayerView.css";

const SHOW_DEV_SHIP_PLAN_PANEL = false;
const SHOW_DEV_SHIP_LOG_PANEL = false;
const GUIDANCE_LOCKED_TEXT = "Hire a navigator for guided suggestions.";
const DEPART_SUGGESTION_GUARD_MS = 1800;
const SUGGESTION_PULSE_MS = 3700;
const INFO_HOVER_CLEAR_DELAY_MS = 90;

export function PlayerView() {
  const world = useStore((s) => s.world);
  useStore((s) => s.tickEpoch);
  const selectedTrader = useStore((s) => s.selectedTrader);
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
  const selectedShip = selectedTrader && player.shipIds.includes(selectedTrader)
    ? world.traders[selectedTrader] ?? ships[0] ?? null
    : ships[0] ?? null;

  return (
    <section className="player-view">
      {lastError && (
        <div className="player-error" onClick={clearError}>
          <span className="bad">⚠</span> {lastError} <span className="faint">(click to dismiss)</span>
        </div>
      )}
      {selectedShip
        ? <ShipPanel key={selectedShip.id} ship={selectedShip} world={world} />
        : <p className="dim">No controlled ship available.</p>}
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
  const guidanceUnlocked = hasCrew(ship, "navigator");
  const guidedPlan = guidanceUnlocked
    ? getGuidedPlan(world, ship, { mode: ship.pilot === "auto" ? "actual" : "advisory" })
    : lockedGuidancePlan();
  const hint = guidedPlan.current;
  const target = guidanceUnlocked ? targetFromGuidedPlan(guidedPlan) : {};
  const cueText = guidanceUnlocked ? cueTextFromGuidedPlan(guidedPlan, world) : emptyCueText(GUIDANCE_LOCKED_TEXT);
  const hintText = cueText.fallback;
  const isCriticalHint = target.critical === true;

  return (
    <article className="ship-panel">
      <DockedView
        ship={ship}
        world={world}
        loc={focusLoc!}
        guidedPlan={guidedPlan}
        hint={hint}
        target={target}
        hintText={hintText}
        cueText={cueText}
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
      <span className="suggested-marker-dot" ref={dotRef} />
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

function lockedGuidancePlan(): GuidedPlan {
  const hint: GuidedHint = { kind: "wait", reason: GUIDANCE_LOCKED_TEXT };
  return { current: hint, hints: [hint] };
}

function targetFromGuidedPlan(guidedPlan: GuidedPlan): HintTarget {
  const target: HintTarget = {};
  const buyGoods: Partial<Record<GoodId, number>> = {};
  const sellGoods = new Set<GoodId>();
  const acceptJobIds = new Set<NonNullable<HintTarget["acceptJobId"]>>();
  const collectJobIds = new Set<JobId>();

  for (const hint of guidedPlan.hints) {
    const stepTarget = hintTarget(hint);
    if (stepTarget.buyGood) {
      buyGoods[stepTarget.buyGood] = (buyGoods[stepTarget.buyGood] ?? 0) + (stepTarget.buyQty ?? 0);
    }
    for (const good of Object.keys(stepTarget.buyGoods ?? {}) as GoodId[]) {
      buyGoods[good] = (buyGoods[good] ?? 0) + (stepTarget.buyGoods?.[good] ?? 0);
    }

    if (stepTarget.sellGood) sellGoods.add(stepTarget.sellGood);
    for (const good of stepTarget.sellGoods ?? []) sellGoods.add(good);

    if (!target.travelTo && stepTarget.travelTo) {
      target.travelTo = stepTarget.travelTo;
      target.travelLabel = stepTarget.travelLabel;
    }
    if (stepTarget.refuel) target.refuel = true;
    if (stepTarget.critical) target.critical = true;
    if (stepTarget.acceptJobId) acceptJobIds.add(stepTarget.acceptJobId);
    for (const jobId of stepTarget.acceptJobIds ?? []) acceptJobIds.add(jobId);
    if (stepTarget.collectJobId) collectJobIds.add(stepTarget.collectJobId);
  }

  const buyEntries = (Object.keys(buyGoods) as GoodId[]).flatMap((good): [GoodId, number][] => {
    const qty = buyGoods[good] ?? 0;
    return qty > 0 ? [[good, qty]] : [];
  });
  if (buyEntries.length > 0) {
    target.buyGoods = buyGoods;
    const onlyBuy = buyEntries[0];
    if (buyEntries.length === 1 && onlyBuy) {
      target.buyGood = onlyBuy[0];
      target.buyQty = onlyBuy[1];
    }
  }

  const sellList = [...sellGoods];
  if (sellList.length > 0) {
    target.sellGoods = sellList;
    if (sellList.length === 1) target.sellGood = sellList[0];
  }

  const jobList = [...acceptJobIds];
  if (jobList.length > 0) {
    target.acceptJobIds = jobList;
    if (jobList.length === 1) target.acceptJobId = jobList[0];
  }

  const collectList = [...collectJobIds];
  if (collectList.length > 0) target.collectJobId = collectList[0];

  return target;
}

type CueTextMap = {
  fallback: string;
  refuel?: string;
  buyGoods: Partial<Record<GoodId, string>>;
  sellGoods: Partial<Record<GoodId, string>>;
  travel: Partial<Record<LocationId, string>>;
  acceptJobs: Partial<Record<JobId, string>>;
  collectJobs: Partial<Record<JobId, string>>;
  sections: {
    market?: string;
    upgrades?: string;
    contracts?: string;
    cargo?: string;
    travel?: string;
  };
};

function emptyCueText(fallback: string): CueTextMap {
  return {
    fallback,
    buyGoods: {},
    sellGoods: {},
    travel: {},
    acceptJobs: {},
    collectJobs: {},
    sections: {},
  };
}

function cueTextFromGuidedPlan(guidedPlan: GuidedPlan, world: World): CueTextMap {
  const fallback = describeHint(guidedPlan.current, world);
  const cue = emptyCueText(fallback);
  const set = <K extends string>(map: Partial<Record<K, string>>, key: K | undefined, value: string) => {
    if (key && map[key] == null) map[key] = value;
  };

  for (const planHint of guidedPlan.hints) {
    const stepTarget = hintTarget(planHint);
    const desc = describeHint(planHint, world);

    if (stepTarget.refuel && cue.refuel == null) cue.refuel = desc;
    if (stepTarget.travelTo) {
      const text = travelCueText(planHint, world, desc);
      set(cue.travel, stepTarget.travelTo, text);
      cue.sections.travel ??= text;
    }

    const buyGoods = new Set<GoodId>();
    if (stepTarget.buyGood) buyGoods.add(stepTarget.buyGood);
    for (const good of Object.keys(stepTarget.buyGoods ?? {}) as GoodId[]) buyGoods.add(good);
    for (const good of buyGoods) {
      const text = buyCueText(planHint, good, world, desc);
      set(cue.buyGoods, good, text);
      if (isUpgradeGood(good)) cue.sections.upgrades ??= `Suggested upgrade: ${world.goods[good]?.name ?? good}.`;
      else cue.sections.market ??= text;
    }

    const sellGoods = new Set<GoodId>();
    if (stepTarget.sellGood) sellGoods.add(stepTarget.sellGood);
    for (const good of stepTarget.sellGoods ?? []) sellGoods.add(good);
    for (const good of sellGoods) {
      const text = sellCueText(planHint, good, world, desc);
      set(cue.sellGoods, good, text);
      if (!isUpgradeGood(good)) cue.sections.cargo ??= text;
    }

    const jobIds = new Set<JobId>();
    if (stepTarget.acceptJobId) jobIds.add(stepTarget.acceptJobId);
    for (const jobId of stepTarget.acceptJobIds ?? []) jobIds.add(jobId);
    for (const jobId of jobIds) {
      const text = contractCueText(planHint, jobId, world, desc);
      set(cue.acceptJobs, jobId, text);
      cue.sections.contracts ??= text;
    }

    if (stepTarget.collectJobId) {
      set(cue.collectJobs, stepTarget.collectJobId, desc);
      cue.sections.contracts ??= desc;
    }
  }

  return cue;
}

function buyCueText(hint: GuidedHint, good: GoodId, world: World, fallback: string): string {
  const goodName = world.goods[good]?.name ?? good;
  switch (hint.kind) {
    case "buy_for_route":
      if (hint.good === good) {
        return `Buy ${formatQty(hint.qty)} ${goodName} for ${world.locations[hint.dst]?.name ?? hint.dst}. Net Ç${Math.round(hint.netProfit).toLocaleString()}.`;
      }
      return fallback;
    case "route_plan": {
      const buy = hint.buys.find(item => item.good === good) ?? hint.futureBuys?.find(item => item.good === good);
      if (buy) {
        return `Load ${formatQty(buy.qty)} ${goodName} for ${world.locations[hint.dst]?.name ?? hint.dst}. Route net Ç${Math.round(hint.expectedNet).toLocaleString()}.`;
      }
      return fallback;
    }
    default:
      return fallback;
  }
}

function sellCueText(hint: GuidedHint, good: GoodId, world: World, fallback: string): string {
  const goodName = world.goods[good]?.name ?? good;
  switch (hint.kind) {
    case "sell_here":
      if (hint.good === good) return `Sell ${formatQty(hint.qty)} ${goodName} here for Ç${Math.round(hint.revenue).toLocaleString()} net.`;
      return fallback;
    case "job_plan": {
      const sell = hint.sells.find(item => item.good === good);
      if (sell) return `Sell ${formatQty(sell.qty)} ${goodName} here for this contract plan.`;
      return fallback;
    }
    case "travel_to_sell":
      if (hint.good === good) return `Carry ${formatQty(hint.qty)} ${goodName} to ${world.locations[hint.dst]?.name ?? hint.dst} before selling.`;
      return fallback;
    default:
      return fallback;
  }
}

function travelCueText(hint: GuidedHint, world: World, fallback: string): string {
  switch (hint.kind) {
    case "buy_for_route":
    case "route_plan":
    case "travel_to_sell":
    case "travel_to_collect_trade_job":
      return `Travel to ${world.locations[hint.dst]?.name ?? hint.dst}. ${fallback}`;
    case "speculate":
      return `Reposition to ${world.locations[hint.via]?.name ?? hint.via}.`;
    default:
      return fallback;
  }
}

function contractCueText(_hint: GuidedHint, jobId: JobId, world: World, fallback: string): string {
  const job = world.jobs[jobId];
  if (!job) return fallback;
  if (job.kind === "trade" || !job.good) return fallback;
  const goodName = world.goods[job.good]?.name ?? job.good;
  const dst = world.locations[job.destination]?.name ?? job.destination;
  return `Accept ${job.tier} ${goodName} contract to ${dst}.`;
}

type GoodInfoFocus = { kind: "good"; good: GoodId; source: "market" | "cargo" };
type StationInfoFocus = { kind: "station"; loc: LocationId; source: "station" | "travel" };
type InfoFocus = GoodInfoFocus | StationInfoFocus;
type InfoPanelKind = "ship" | "station" | "good";
type InfoPanelPhase = "idle" | "exiting" | "entering";
type InfoPanelTransition = {
  renderedFocus: InfoFocus | null;
  renderedKey: string;
  renderedKind: InfoPanelKind;
  pendingFocus: InfoFocus | null;
  pendingKey: string | null;
  pendingKind: InfoPanelKind | null;
  phase: InfoPanelPhase;
};

function infoFocusKey(focus: InfoFocus): string {
  return focus.kind === "good"
    ? `good:${focus.source}:${focus.good}`
    : `station:${focus.loc}`;
}

function infoPanelKind(focus: InfoFocus | null): InfoPanelKind {
  return focus == null ? "ship" : focus.kind;
}

function infoPanelKey(focus: InfoFocus | null): string {
  return focus ? infoFocusKey(focus) : "ship-info";
}

function infoFocusLabel(focus: InfoFocus, world: World): string {
  if (focus.kind === "good") {
    const name = world.goods[focus.good]?.name ?? focus.good;
    return focus.source === "cargo" ? `${name} cargo` : name;
  }
  return world.locations[focus.loc]?.name ?? focus.loc;
}

function SectionIntro({ title, subtitle, trailing }: {
  title: string;
  subtitle?: string;
  trailing?: ReactNode;
}) {
  return (
    <div className="bridge-section-intro">
      <div>
        <span className="bridge-section-title">{title}</span>
        {subtitle && <span className="bridge-section-subtitle">{subtitle}</span>}
      </div>
      {trailing}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="cargo-stat">
      <dt className="dim">{label}</dt>
      <dd key={value} className="mono info-value">{value}</dd>
    </div>
  );
}

function DockedView({ ship, world, loc, guidedPlan, hint, target, hintText, cueText, critical, inTransit }: {
  ship: Trader; world: World; loc: LocationDef; guidedPlan: GuidedPlan; hint: GuidedHint; target: HintTarget; hintText: string; cueText: CueTextMap; critical: boolean; inTransit: boolean;
}) {
  const [hoveredFocus, setHoveredFocus] = useState<InfoFocus | null>(null);
  const [pinnedFocuses, setPinnedFocuses] = useState<InfoFocus[]>([]);
  const [activePinnedKey, setActivePinnedKey] = useState<string | null>(null);
  const [suggestionPulse, setSuggestionPulse] = useState(0);
  const suggestionPulseTimer = useRef<number | null>(null);
  const hoverClearTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (suggestionPulseTimer.current != null) window.clearTimeout(suggestionPulseTimer.current);
    if (hoverClearTimer.current != null) window.clearTimeout(hoverClearTimer.current);
  }, []);
  const setHoverFocus = (focus: InfoFocus) => {
    if (hoverClearTimer.current != null) {
      window.clearTimeout(hoverClearTimer.current);
      hoverClearTimer.current = null;
    }
    setHoveredFocus(focus);
  };
  const clearHoverFocus = () => {
    if (hoverClearTimer.current != null) window.clearTimeout(hoverClearTimer.current);
    hoverClearTimer.current = window.setTimeout(() => {
      setHoveredFocus(null);
      hoverClearTimer.current = null;
    }, INFO_HOVER_CLEAR_DELAY_MS);
  };
  const pulseSuggestionActions = () => {
    setSuggestionPulse(prev => (prev % 2) + 1);
    if (suggestionPulseTimer.current != null) window.clearTimeout(suggestionPulseTimer.current);
    suggestionPulseTimer.current = window.setTimeout(() => {
      setSuggestionPulse(0);
      suggestionPulseTimer.current = null;
    }, SUGGESTION_PULSE_MS);
  };
  const activePinned = activePinnedKey
    ? pinnedFocuses.find(focus => infoFocusKey(focus) === activePinnedKey) ?? null
    : null;
  const activeFocus = hoveredFocus ?? activePinned;
  const pinFocus = (focus: InfoFocus) => {
    const key = infoFocusKey(focus);
    setPinnedFocuses(prev => prev.some(item => infoFocusKey(item) === key) ? prev : [...prev, focus]);
    setActivePinnedKey(key);
  };
  const closePinnedFocus = (key: string) => {
    setPinnedFocuses(prev => prev.filter(item => infoFocusKey(item) !== key));
    setActivePinnedKey(current => current === key ? null : current);
  };
  const togglePinnedFocus = (focus: InfoFocus) => {
    const key = infoFocusKey(focus);
    if (pinnedFocuses.some(item => infoFocusKey(item) === key)) {
      closePinnedFocus(key);
    } else {
      pinFocus(focus);
    }
  };
  const clearInfoFocus = () => {
    if (hoverClearTimer.current != null) {
      window.clearTimeout(hoverClearTimer.current);
      hoverClearTimer.current = null;
    }
    setHoveredFocus(null);
    setActivePinnedKey(null);
  };
  const pinnedMarketGoods = new Set<GoodId>();
  const pinnedCargoGoods = new Set<GoodId>();
  const pinnedStations = new Set<LocationId>();
  for (const pinned of pinnedFocuses) {
    if (pinned.kind === "station") pinnedStations.add(pinned.loc);
    else if (pinned.source === "cargo") pinnedCargoGoods.add(pinned.good);
    else pinnedMarketGoods.add(pinned.good);
  }

  const pulseClass = suggestionPulse === 0
    ? ""
    : suggestionPulse === 1
      ? "suggestion-pulse-odd"
      : "suggestion-pulse-even";

  return (
    <div className={`docked-view ${pulseClass}`}>
      <div className="bridge">
        <ShipCard
          ship={ship}
          world={world}
          loc={loc}
          guidedPlan={guidedPlan}
          target={target}
          hintText={hintText}
          cueText={cueText}
          critical={critical}
          inTransit={inTransit}
          selectedGood={activeFocus?.kind === "good" && activeFocus.source === "cargo" ? activeFocus.good : null}
          pinnedGoods={pinnedCargoGoods}
          onSelectGood={(good) => togglePinnedFocus({ kind: "good", good, source: "cargo" })}
          onHoverGood={(good) => {
            if (good) setHoverFocus({ kind: "good", good, source: "cargo" });
            else clearHoverFocus();
          }}
        />
        <TravelOptions
          ship={ship}
          world={world}
          loc={loc}
          target={target}
          hintText={hintText}
          cueText={cueText}
          selectedStation={activeFocus?.kind === "station" ? activeFocus.loc : null}
          pinnedStations={pinnedStations}
          inTransit={inTransit}
          onSelectStation={(station) => togglePinnedFocus({ kind: "station", loc: station, source: "travel" })}
          onHoverStation={(station) => {
            if (station) setHoverFocus({ kind: "station", loc: station, source: "travel" });
            else clearHoverFocus();
          }}
          onPulseSuggestions={pulseSuggestionActions}
        />
      </div>
      <div className="bridge-split">
        <StationExchangeCard
          ship={ship}
          world={world}
          loc={loc}
          target={target}
          hintText={hintText}
          cueText={cueText}
          selectedGood={activeFocus?.kind === "good" && activeFocus.source === "market" ? activeFocus.good : null}
          pinnedGoods={pinnedMarketGoods}
          inTransit={inTransit}
          onSelectGood={(good) => togglePinnedFocus({ kind: "good", good, source: "market" })}
          onHoverGood={(good) => {
            if (good) setHoverFocus({ kind: "good", good, source: "market" });
            else clearHoverFocus();
          }}
        />
        <InfoAreaCard
          ship={ship}
          world={world}
          loc={loc}
          focus={activeFocus}
          pinnedFocuses={pinnedFocuses}
          activePinnedKey={activePinnedKey}
          onSelectPinned={setActivePinnedKey}
          onClosePinned={closePinnedFocus}
          onClearFocus={clearInfoFocus}
          target={target}
          hint={hint}
        />
      </div>
      {SHOW_DEV_SHIP_LOG_PANEL && <ShipLogCard ship={ship} />}
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

function ContractsTab({ ship, world, loc, target, hintText, cueText, interactionLocked }: {
  ship: Trader; world: World; loc: LocationDef; target: HintTarget; hintText: string; cueText: CueTextMap; interactionLocked: boolean;
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
      {jobs.length === 0 ? (
        <div className="contract-empty">No open contracts here.</div>
      ) : (
        <table className="jobs-table contract-table available-contracts-table">
          <colgroup>
            <col className="col-tier" />
            <col />
            <col className="col-dest" />
            <col className="col-num" />
            <col className="col-held" />
            <col className="col-money" />
            <col className="col-money" />
            <col className="col-expires" />
            {manualActions && <col className="col-action" />}
          </colgroup>
          <thead>
            <tr>
              <th>Tier</th>
              <th>Contract</th>
              <th>Route</th>
              <th className="numeric">Qty</th>
              <th className="numeric">Held</th>
              <th className="numeric">Reward</th>
              <th className="numeric">Penalty</th>
              <th className="numeric">Expires</th>
              {manualActions && <th></th>}
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <LocalJobRow
                key={j.id}
                job={j}
                world={world}
                ship={ship}
                suggested={target.acceptJobId === j.id || target.acceptJobIds?.includes(j.id) === true}
                hintText={cueText.acceptJobs[j.id] ?? hintText}
                showAction={manualActions}
                interactionLocked={interactionLocked}
                onAccept={() => acceptJob(j.id, ship.id)}
              />
            ))}
          </tbody>
        </table>
      )}
      {activeJobs.length > 0 && (
        <>
          <SectionIntro
            title="Active"
            subtitle={`${activeJobs.length} contract${activeJobs.length === 1 ? "" : "s"} assigned to ${ship.name}`}
          />
          <ActiveContractsTab ship={ship} world={world} jobs={activeJobs} target={target} cueText={cueText} hintText={hintText} />
        </>
      )}
    </div>
  );
}

const TIER_RANK: Record<Job["tier"], number> = { high: 0, medium: 1, low: 2 };
function localJobSort(a: Job, b: Job): number {
  const t = TIER_RANK[a.tier] - TIER_RANK[b.tier];
  return t !== 0 ? t : a.expiresAt - b.expiresAt;
}

function LocalJobRow({ job, world, ship, suggested, hintText, showAction, interactionLocked, onAccept }: {
  job: Job; world: World; ship: Trader; suggested: boolean; hintText: string; showAction: boolean; interactionLocked: boolean; onAccept: () => void;
}) {
  const good = job.good ? world.goods[job.good]?.name ?? job.good : "Contract";
  const ticksLeft = Math.max(0, job.expiresAt - world.tick);
  const expiringSoon = ticksLeft <= 10;
  const onHand = job.good ? ship.cargo.filter(l => l.good === job.good).reduce((s, l) => s + l.qty, 0) : 0;
  const onHandTone = onHand >= job.qty ? "good" : onHand > 0 ? "warn" : "faint";
  const dst = world.locations[job.destination]?.name ?? job.destination;
  const remote = job.destination !== ship.location;
  return (
    <tr className={`contract-row contract-tier-${job.tier}`}>
      <td><span className={`tier-badge tier-${job.tier}`}>{job.tier.toUpperCase()}</span></td>
      <td>
        <span className="contract-title-row">
          <span className="contract-good">{good}</span>
          {job.kind === "rescue" && (
            <span className="job-kind-tag" title={job.rescueTarget ? `Rescue ${world.traders[job.rescueTarget]?.name ?? job.rescueTarget}` : "Rescue contract"}>
              rescue
            </span>
          )}
        </span>
      </td>
      <td className="dim mono">{remote ? `to ${dst}` : "here"}</td>
      <td className="numeric mono">{job.qty.toLocaleString()}</td>
      <td className={`numeric mono ${onHandTone}`}>{onHand > 0 ? onHand.toFixed(0) : "—"}</td>
      <td className="numeric mono good">Ç{job.reward.toLocaleString()}</td>
      <td className={`numeric mono ${job.penalty > 0 ? "bad" : "faint"}`}>{job.penalty > 0 ? `Ç${job.penalty.toLocaleString()}` : "—"}</td>
      <td className={`numeric mono ${expiringSoon ? "warn" : "dim"}`}>{ticksLeft}t</td>
      {showAction && (
        <td>
          <ActionCell suggested={suggested} hintText={hintText}>
            <button
              className={`btn-action ${suggested ? "btn-suggested" : "primary"}`}
              onClick={onAccept}
              disabled={interactionLocked}
              title={interactionLocked ? "Arrive before accepting contracts" : undefined}
            >
              <span className="btn-label">Accept</span>
            </button>
          </ActionCell>
        </td>
      )}
    </tr>
  );
}

function TransitProgress({ ship, world }: { ship: Trader; world: World }) {
  if (ship.state !== "transit" || ship.destination == null) return null;
  // Recover total trip ticks from origin/destination distance; fuel was burned
  // on departure, but location remains the origin until arrival resolves.
  const tripDist = distance(world, ship.location, ship.destination);
  const totalTicks = Math.max(1, Math.ceil(tripDist / ship.speed));
  const elapsed = Math.max(0, totalTicks - ship.ticksRemaining);
  const pct = Math.max(0, Math.min(100, (elapsed / totalTicks) * 100));

  return (
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
  );
}

function stationImports(loc: LocationDef, world: World): string[] {
  // imports = goods this loc consumes more than produces
  return loc.consumes
    .filter(c => {
      const p = loc.produces.find(x => x.good === c.good)?.ratePerTick ?? 0;
      return p < c.ratePerTick;
    })
    .map(c => world.goods[c.good]?.name ?? c.good);
}

function stationPopulation(loc: LocationDef): string {
  return loc.population >= 1000 ? `${(loc.population / 1000).toFixed(1)}k` : loc.population.toLocaleString();
}

type StationPressureTone = "short" | "surplus" | "";

function artCardStyle(url: string): CSSProperties {
  return { "--card-art": `url("${url}")` } as CSSProperties;
}

function InfoPanelFrame({ eyebrow, title, badge, meta, metaClassName = "", children }: {
  eyebrow: string;
  title: string;
  badge?: ReactNode;
  meta: ReactNode;
  metaClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className="info-panel-frame">
      <div className="info-panel-fixed">
        <header className="bridge-card-head">
          <div className="bridge-card-title">
            <span className="bridge-card-eyebrow station-eyebrow">{eyebrow}</span>
            <span className="trade-helper-good">{title}</span>
          </div>
          {badge}
        </header>

        <div className={`trade-helper-meta ${metaClassName}`}>
          {meta}
        </div>
      </div>

      <div className="info-panel-scroll">
        {children}
      </div>
    </div>
  );
}

function stationCounts(world: World, id: LocationId) {
  const traders = Object.values(world.traders);
  return {
    docked: traders.filter(t => t.state === "idle" && t.location === id).length,
    inbound: traders.filter(t => t.state === "transit" && t.destination === id).length,
    jobs: Object.values(world.jobs).filter(j => j.destination === id && j.acceptedBy == null).length,
    routes: reachableNeighbors(world, id).length,
  };
}

function stationMarketRows(world: World, loc: LocationDef) {
  const market = world.markets[loc.id];
  return (Object.keys(world.goods) as GoodId[])
    .map(good => {
      const def = world.goods[good];
      const target = loc.targetStock[good] ?? 0;
      const stock = market.stock[good] ?? 0;
      const price = market.prices[good] ?? def.basePrice;
      const ratio = target > 0 ? stock / target : 1;
      const tone: StationPressureTone = target > 0 && ratio < 0.45
        ? "short"
        : target > 0 && ratio > 1.8
          ? "surplus"
          : "";
      return { good, name: def.name, stock, target, price, base: def.basePrice, tone };
    })
    .filter(row => row.target > 0 || row.stock > 0.001)
    .sort((a, b) => {
      const toneRank = (tone: StationPressureTone) => tone === "short" ? 0 : tone === "surplus" ? 1 : 2;
      return toneRank(a.tone) - toneRank(b.tone)
        || Math.abs((b.price / b.base) - 1) - Math.abs((a.price / a.base) - 1)
        || a.name.localeCompare(b.name);
    });
}

function goodsList(world: World, goods: GoodId[], max = 5): string {
  const shown = goods.slice(0, max).map(good => world.goods[good]?.name ?? good);
  const more = goods.length > shown.length ? ` +${goods.length - shown.length}` : "";
  return shown.length > 0 ? `${shown.join(", ")}${more}` : "None listed";
}

function StationTradeHelperInfoContent({ loc, world }: { loc: LocationDef; world: World }) {
  const imports = stationImports(loc, world);
  const kind = stationKind(loc);
  const subtype = stationSubtype(loc, kind);
  const scale = stationScale(loc, kind);
  const counts = stationCounts(world, loc.id);
  const population = stationPopulation(loc);
  const marketRows = stationMarketRows(world, loc);
  const pressureRows = marketRows.filter(row => row.tone !== "").slice(0, 6);
  const routeRows = reachableNeighbors(world, loc.id)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 5);
  const stockedGoods = marketRows.filter(row => row.stock > 0.001 && !isUpgradeGood(row.good)).length;
  const stockedUpgrades = marketRows.filter(row => row.stock >= 1 && isUpgradeGood(row.good)).length;
  const producedFlow = loc.produces
    .filter(entry => entry.ratePerTick > 0)
    .sort((a, b) => b.ratePerTick - a.ratePerTick)
    .slice(0, 5);
  const consumedFlow = loc.consumes
    .filter(entry => entry.ratePerTick > 0)
    .sort((a, b) => b.ratePerTick - a.ratePerTick)
    .slice(0, 5);

  return (
    <InfoPanelFrame
      eyebrow="Station info"
      title={loc.name}
      badge={<span className={`station-kind-pill station-kind-${kind}`}>{stationKindLabel(kind)}</span>}
      metaClassName="station-info-tags"
      meta={(
        <>
          {loc.traits.faction && <span>{loc.traits.faction}</span>}
          {subtype && <span>{stationSubtypeLabel(subtype)}</span>}
          <span>{stationScaleLabel(scale)}</span>
          {loc.traits.tags.map(t => <span key={t}>{t}</span>)}
        </>
      )}
    >
      <dl className="trade-helper-grid station-info-grid">
        <Stat label="tech" value={`L${loc.traits.techLevel}`} />
        <Stat label="population" value={population} />
        <Stat label="routes" value={counts.routes.toLocaleString()} />
        <Stat label="traffic" value={`${counts.docked}+${counts.inbound} ships`} />
        <Stat label="contracts" value={counts.jobs.toLocaleString()} />
        <Stat label="market" value={`${stockedGoods} goods / ${stockedUpgrades} upgrades`} />
      </dl>

      <div className="trade-helper-section">
        <div className="exchange-section-title">Profile</div>
        <div className="trade-helper-line">
          <span>Coordinates</span>
          <span className="mono">x {loc.position.x.toFixed(1)} / y {loc.position.y.toFixed(1)}</span>
        </div>
        <div className="trade-helper-line">
          <span>Exports</span>
          <span>{goodsList(world, loc.primaryExports)}</span>
        </div>
        <div className="trade-helper-line">
          <span>Imports</span>
          <span>{imports.length > 0 ? imports.slice(0, 5).join(", ") : goodsList(world, loc.primaryImports)}</span>
        </div>
      </div>

      <div className="trade-helper-section">
        <div className="exchange-section-title">Station flow</div>
        <div className="station-flow-pills">
          {producedFlow.map(entry => (
            <span key={`p-${entry.good}`}>+{entry.ratePerTick.toFixed(1)}/t {world.goods[entry.good]?.name ?? entry.good}</span>
          ))}
          {consumedFlow.map(entry => (
            <span key={`c-${entry.good}`}>-{entry.ratePerTick.toFixed(1)}/t {world.goods[entry.good]?.name ?? entry.good}</span>
          ))}
        </div>
      </div>

      <div className="trade-helper-section">
        <div className="exchange-section-title">Market pressure</div>
        {pressureRows.length === 0 ? (
          <div className="trade-helper-line muted"><span>Stock</span><span>Markets are near target</span></div>
        ) : (
          <table className="trade-helper-market-table">
            <thead>
              <tr>
                <th>Good</th>
                <th className="numeric">Stock</th>
                <th className="numeric">Price</th>
                <th className="numeric">State</th>
              </tr>
            </thead>
            <tbody>
              {pressureRows.map(row => (
                <tr key={row.good}>
                  <td title={row.name}>{row.name}</td>
                  <td className="numeric mono">{row.stock.toFixed(0)} / {row.target.toFixed(0)}</td>
                  <td className="numeric mono">Ç{row.price.toFixed(1)}</td>
                  <td className={`numeric ${row.tone}`}>{row.tone}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="trade-helper-section">
        <div className="exchange-section-title">Nearby routes</div>
        {routeRows.length === 0 ? (
          <div className="trade-helper-line muted"><span>Routes</span><span>No direct lanes</span></div>
        ) : (
          <table className="trade-helper-market-table station-routes-table">
            <thead>
              <tr>
                <th>Station</th>
                <th className="numeric">Dist</th>
                <th className="numeric">Jobs</th>
              </tr>
            </thead>
            <tbody>
              {routeRows.map(row => {
                const jobs = Object.values(world.jobs).filter(job => job.destination === row.to && job.acceptedBy == null).length;
                return (
                  <tr key={row.to}>
                    <td title={world.locations[row.to]?.name ?? row.to}>{world.locations[row.to]?.name ?? row.to}</td>
                    <td className="numeric mono">{row.dist.toFixed(1)}</td>
                    <td className="numeric mono">{jobs}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </InfoPanelFrame>
  );
}

function ShipCard({ ship, world, loc, guidedPlan, target, hintText, cueText, critical, inTransit, selectedGood, pinnedGoods, onSelectGood, onHoverGood }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  guidedPlan: GuidedPlan;
  target: HintTarget;
  hintText: string;
  cueText: CueTextMap;
  critical: boolean;
  inTransit: boolean;
  selectedGood: GoodId | null;
  pinnedGoods: Set<GoodId>;
  onSelectGood: (good: GoodId) => void;
  onHoverGood: (good: GoodId | null) => void;
}) {
  const repairShip = useStore((s) => s.repairShip);
  const mass = cargoMassFn(ship, world);
  const cargoPct = (mass / ship.capacity) * 100;
  const groups = groupCargoByGood(ship);

  const debt = ship.maintenanceDebt ?? 0;
  const canRepair = debt > 0 && ship.state === "idle";

  return (
    <section className="bridge-card ship-card">
      <div className="ship-status-tabs bridge-card-tabs">
        <ShipFuelStatusEntry ship={ship} world={world} target={target} hintText={cueText.refuel ?? hintText} critical={critical} inTransit={inTransit} />
        <ShipMaintenanceStatusEntry debt={debt} canRepair={canRepair} onRepair={() => repairShip(ship.id)} />
      </div>
      <ShipCargoTabs
        ship={ship}
        world={world}
        loc={loc}
        groups={groups}
        inTransit={inTransit}
        target={target}
        hintText={hintText}
        cueText={cueText}
        cargoUsed={mass}
        cargoPct={cargoPct}
        selectedGood={selectedGood}
        pinnedGoods={pinnedGoods}
        onSelectGood={onSelectGood}
        onHoverGood={onHoverGood}
      />
      {SHOW_DEV_SHIP_PLAN_PANEL && <ShipPlanPanel ship={ship} world={world} guidedPlan={guidedPlan} hintText={hintText} />}
    </section>
  );
}

function meterTabStyle(pct: number): CSSProperties {
  return { "--meter-pct": `${Math.max(0, Math.min(100, pct))}%` } as CSSProperties;
}

function ShipFuelStatusEntry({ ship, world, target, hintText, critical, inTransit }: {
  ship: Trader; world: World; target: HintTarget; hintText: string; critical: boolean; inTransit: boolean;
}) {
  const refuel = useStore((s) => s.refuel);
  const manualActions = ship.pilot !== "auto";
  const fuel = ship.currentFuel;
  const fuelQty = fuel?.qty ?? 0;
  const fuelPct = ship.fuelCapacity > 0 ? (fuelQty / ship.fuelCapacity) * 100 : 0;
  const tone = fuelPct < 15 ? "bad" : fuelPct < 50 ? "warn" : "";
  const tankGood = fuel ? world.goods[fuel.good]?.name ?? fuel.good : "No fuel";
  const fuelKind = fuel ? tankGood.replace(/\s+(Fuel|Cell)$/u, "") : "Plasma";
  const fuelLabel = fuelPct < 15
    ? `Critical ${fuelKind}`
    : fuelPct <= 30
      ? `Low ${fuelKind}`
      : fuelPct < 50
        ? `${fuelKind} Draining`
        : fuelKind;
  const attention = fuelPct <= 30;
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
  const canRefuel = !inTransit && manualActions && refuelType != null && fillable > 0.001;
  const percentText = `${Math.round(fuelPct)}%`;
  const status = inTransit
    ? "Dock to refuel"
    : refuelType
      ? `Station: ${stationFuel} · ${stock.toFixed(0)} stock · Ç${Math.round(price)}/u`
      : "No compatible fuel at station";
  const disabledTitle = !manualActions
    ? "Auto mode controls refueling"
    : room <= 0.001
      ? "Tank already full"
      : stock <= 0.001
        ? "No compatible fuel for sale here"
        : "Not enough funds to refuel";
  const actionTitle = canRefuel ? (critical ? "Refuel now" : switching ? "Switch fuel and fill" : "Fill tank") : disabledTitle;

  return (
    <ActionCell suggested={suggested} hintText={hintText} critical={critical}>
      <button
        className={`bridge-tab ship-meter-tab ship-status-entry ship-fuel-entry ${tone} ${attention ? "attention" : ""} ${suggested ? "has-suggestion" : ""} ${critical ? "btn-suggested-critical" : suggested ? "btn-suggested" : ""}`}
        style={meterTabStyle(fuelPct)}
        onClick={() => refuel(ship.id)}
        disabled={!canRefuel}
        title={`${status} · ${actionTitle}`}
      >
        <span className="ship-meter-label">{fuelLabel}</span>
        <span className="ship-meter-percent">{percentText}</span>
      </button>
    </ActionCell>
  );
}

function ShipMaintenanceStatusEntry({ debt, canRepair, onRepair }: { debt: number; canRepair: boolean; onRepair: () => void }) {
  const damagePct = Math.max(0, Math.min(100, (debt / MAINTENANCE_DEBT_TRAVEL_BLOCK) * 100));
  const conditionPct = Math.max(0, 100 - damagePct);
  const grounded = debt >= MAINTENANCE_DEBT_TRAVEL_BLOCK;
  const tone = grounded ? "bad" : conditionPct <= 30 ? "warn" : "";
  const attention = conditionPct <= 30;
  const hasDebt = debt > 0.001;
  const percentText = `${Math.round(damagePct)}%`;
  const status = grounded
    ? `Grounded · hull damage Ç${Math.round(debt).toLocaleString()}`
    : hasDebt
      ? `Hull damage Ç${Math.round(debt).toLocaleString()}`
      : "Hull clear";
  const clickable = hasDebt && canRepair;

  return (
    <ActionCell suggested={grounded} hintText="Repair hull damage before travel." critical>
      <button
        className={`bridge-tab ship-meter-tab ship-status-entry ship-maintenance-entry ${tone} ${attention ? "attention" : ""} ${grounded ? "has-suggestion btn-suggested-critical" : ""}`}
        style={meterTabStyle(damagePct)}
        onClick={onRepair}
        disabled={!clickable}
        title={`${status}${hasDebt ? canRepair ? " · Repair ship" : " · Dock to repair" : ""}`}
      >
        <span className="ship-meter-label">Hull Damage</span>
        <span className="ship-meter-percent">{percentText}</span>
      </button>
    </ActionCell>
  );
}

type PlanTone = "" | "warn" | "bad";
type PlanStep = { icon: IconType; text: string; tone?: PlanTone; current?: boolean };
type ShipPlan = { label: string; meta: string; tone: PlanTone; steps: PlanStep[]; note?: string };

function ShipPlanPanel({ ship, world, guidedPlan, hintText }: {
  ship: Trader; world: World; guidedPlan: GuidedPlan; hintText: string;
}) {
  const plan = buildShipPlan(ship, world, guidedPlan, hintText);

  return (
    <div className={`ship-plan-panel ${plan.tone}`}>
      <div className="ship-plan-head">
        <span className="ship-plan-label">{plan.label}</span>
        <span className="ship-plan-meta mono">{plan.meta}</span>
      </div>
      <ol className="ship-plan-steps">
        {plan.steps.map((step, i) => {
          const Icon = step.icon;
          const classes = [
            step.current ? "current" : "queued",
            step.tone ? `tone-${step.tone}` : "",
          ].filter(Boolean).join(" ");
          return (
            <li key={`${step.text}-${i}`} className={classes}>
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

function buildShipPlan(ship: Trader, world: World, guidedPlan: GuidedPlan, hintText: string): ShipPlan {
  const base = buildHintShipPlan(ship, world, guidedPlan.current, hintText);
  const steps = guidedPlan.hints.flatMap((hint, hintIndex) => {
    const hintPlan = hintIndex === 0
      ? base
      : buildHintShipPlan(ship, world, hint, describeHint(hint, world));
    return hintPlan.steps.map((step, stepIndex) => ({
      ...step,
      current: hintIndex === 0 && stepIndex === 0,
    }));
  });
  return {
    ...base,
    meta: guidedPlan.hints.length > 1 ? `${steps.length} steps` : base.meta,
    steps,
  };
}

function buildHintShipPlan(ship: Trader, world: World, hint: GuidedHint, hintText: string): ShipPlan {
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
  return target.acceptJobId != null || (target.acceptJobIds?.length ?? 0) > 0 || target.collectJobId != null;
}

function targetSuggestsLocalContracts(world: World, target: HintTarget, ship: Trader): boolean {
  if (target.collectJobId) {
    const job = world.jobs[target.collectJobId];
    if (job?.destination === ship.location) return true;
  }
  const acceptIds = [
    ...(target.acceptJobId ? [target.acceptJobId] : []),
    ...(target.acceptJobIds ?? []),
  ];
  return acceptIds.some(jobId => world.jobs[jobId]?.destination === ship.location);
}

function targetSuggestsCargoAction(target: HintTarget): boolean {
  return [target.sellGood, ...(target.sellGoods ?? [])]
    .filter((good): good is GoodId => good != null)
    .some(good => !isUpgradeGood(good));
}

function shouldGuardDepartureForSuggestions(world: World, target: HintTarget, destination: LocationId, ship: Trader): boolean {
  const hasLocalSuggestedAction =
    targetBuyGoods(target).length > 0
    || target.sellGood != null
    || (target.sellGoods?.length ?? 0) > 0
    || targetSuggestsLocalContracts(world, target, ship)
    || target.refuel === true
    || (ship.maintenanceDebt ?? 0) >= MAINTENANCE_DEBT_TRAVEL_BLOCK;
  const suggestedDifferentDestination = target.travelTo != null && target.travelTo !== destination;
  return hasLocalSuggestedAction || suggestedDifferentDestination;
}

function StationExchangeCard({ ship, world, loc, target, hintText, cueText, selectedGood, pinnedGoods, inTransit, onSelectGood, onHoverGood }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  target: HintTarget;
  hintText: string;
  cueText: CueTextMap;
  selectedGood: GoodId | null;
  pinnedGoods: Set<GoodId>;
  inTransit: boolean;
  onSelectGood: (good: GoodId) => void;
  onHoverGood: (good: GoodId | null) => void;
}) {
  const [tab, setTab] = useState<"markets" | "upgrades" | "offers" | "contracts">("markets");
  const manualActions = ship.pilot !== "auto";
  const market = world.markets[loc.id];
  const offers = listHiresAt(world, loc.id);
  const localContractCount = listLocalJobs(world, loc.id).length;
  const activeContractCount = Object.values(world.jobs).filter(j => j.acceptedBy === ship.id).length;
  const marketGoodsCount = Object.keys(world.goods).filter(gid =>
    !isUpgradeGood(gid)
    && ((market.stock[gid] ?? 0) > 0.001 || findCargoLot(ship, gid) != null)
  ).length;
  const upgradeCount = Object.keys(world.goods).filter(gid => isUpgradeGood(gid) && (market.stock[gid] ?? 0) >= 1).length;
  const contractCount = localContractCount + activeContractCount;
  const marketsSuggested = manualActions && targetSuggestsMarketAction(target);
  const upgradesSuggested = manualActions && targetSuggestsUpgradeBuy(target);
  const contractsSuggested = manualActions && targetSuggestsContracts(target);
  const marketHintText = cueText.sections.market ?? hintText;
  const upgradeHintText = cueText.sections.upgrades ?? hintText;
  const contractHintText = cueText.sections.contracts ?? hintText;
  const sectionIntro = tab === "markets"
    ? {
        title: "Station goods",
        subtitle: `${marketGoodsCount} tradable good${marketGoodsCount === 1 ? "" : "s"} at ${loc.name}`,
      }
    : tab === "upgrades"
      ? {
          title: "Station modules",
          subtitle: `${upgradeCount} upgrade module${upgradeCount === 1 ? "" : "s"} stocked`,
        }
      : tab === "offers"
        ? {
            title: "Crew board",
            subtitle: `${offers.length} posted hire offer${offers.length === 1 ? "" : "s"}`,
          }
        : {
            title: "Local",
            subtitle: `${localContractCount} contract${localContractCount === 1 ? "" : "s"} posted for ${loc.name}`,
          };

  return (
    <section className={`bridge-card market-card exchange-card ${inTransit ? "transit-preview-card" : ""}`}>
      <div className="bridge-card-tabs">
        <button
          className={`bridge-tab ${tab === "markets" ? "active" : ""} ${marketsSuggested ? "has-suggestion" : ""}`}
          onClick={() => setTab("markets")}
          title={marketsSuggested ? marketHintText : undefined}
        >
          Markets <span className="bridge-tab-count">{marketGoodsCount}</span>
        </button>
        <button
          className={`bridge-tab ${tab === "upgrades" ? "active" : ""} ${upgradesSuggested ? "has-suggestion" : ""}`}
          onClick={() => setTab("upgrades")}
          title={upgradesSuggested ? upgradeHintText : undefined}
        >
          Upgrades <span className="bridge-tab-count">{upgradeCount}</span>
        </button>
        <button className={`bridge-tab ${tab === "offers" ? "active" : ""}`} onClick={() => setTab("offers")}>
          Offers <span className="bridge-tab-count">{offers.length}</span>
        </button>
        <button
          className={`bridge-tab ${tab === "contracts" ? "active" : ""} ${contractsSuggested ? "has-suggestion" : ""}`}
          onClick={() => setTab("contracts")}
          title={contractsSuggested ? contractHintText : undefined}
        >
          Contracts <span className="bridge-tab-count">{contractCount}</span>
        </button>
      </div>
      <SectionIntro {...sectionIntro} />
      <div className={inTransit ? "transit-preview-content" : undefined}>
        {tab === "markets" && (
          <MarketTableBody
            ship={ship}
            world={world}
            loc={loc}
            target={target}
            hintText={hintText}
            cueText={cueText}
            selectedGood={selectedGood}
            pinnedGoods={pinnedGoods}
            interactionLocked={inTransit}
            onSelectGood={onSelectGood}
            onHoverGood={onHoverGood}
          />
        )}
        {tab === "upgrades" && <StationUpgradePurchaseTab ship={ship} world={world} loc={loc} target={target} hintText={hintText} cueText={cueText} interactionLocked={inTransit} />}
        {tab === "offers" && <HireOffersTab ship={ship} world={world} loc={loc} interactionLocked={inTransit} />}
        {tab === "contracts" && <ContractsTab ship={ship} world={world} loc={loc} target={target} hintText={hintText} cueText={cueText} interactionLocked={inTransit} />}
      </div>
    </section>
  );
}

function MarketTableBody({ ship, world, loc, target, hintText, cueText, selectedGood, pinnedGoods, interactionLocked, onSelectGood, onHoverGood }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  target: HintTarget;
  hintText: string;
  cueText: CueTextMap;
  selectedGood: GoodId | null;
  pinnedGoods: Set<GoodId>;
  interactionLocked: boolean;
  onSelectGood: (good: GoodId) => void;
  onHoverGood: (good: GoodId | null) => void;
}) {
  const buy = useStore((s) => s.buy);
  const manualActions = ship.pilot !== "auto";
  const market = world.markets[loc.id];
  const goodsOrdered = (Object.keys(world.goods) as GoodId[]).filter((gid) =>
    !isUpgradeGood(gid) && ((market.stock[gid] ?? 0) > 0.001 || findCargoLot(ship, gid) != null)
  );
  return (
    <div
      className="market-table-zone"
      onMouseLeave={() => onHoverGood(null)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) onHoverGood(null);
      }}
    >
      <table className={`market-table ${!manualActions ? "market-table-readonly" : ""}`}>
        <colgroup>
          <col className="col-good" />
          <col className="col-num" />
          <col className="col-held" />
          <col className="col-num" />
          <col className="col-net-sell" />
          {manualActions && <col className="col-action" />}
        </colgroup>
        <thead>
          <tr>
            <th>Good</th>
            <th className="numeric">Stock</th>
            <th className="numeric">Held</th>
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
            const pinned = pinnedGoods.has(gid);
            return (
              <tr
                key={gid}
                aria-selected={selectedGood === gid}
              >
                <td>
                  <button
                    type="button"
                    className="row-title-with-pin info-focus-trigger"
                    aria-pressed={pinned}
                    onMouseEnter={() => onHoverGood(gid)}
                    onMouseLeave={() => onHoverGood(null)}
                    onFocus={() => onHoverGood(gid)}
                    onBlur={() => onHoverGood(null)}
                    onClick={() => onSelectGood(gid)}
                  >
                    <span className="good-name">{world.goods[gid].name}</span>
                    {pinned && <MdPushPin className="ui-icon row-pin-icon" aria-hidden="true" focusable="false" />}
                  </button>
                  {isFuel && <span className="row-meta-pill muted">fuel</span>}
                </td>
                <td className="numeric mono">{stock.toFixed(0)}</td>
                <td className={`numeric mono market-held-cell ${isCargo ? "" : "dim"}`}>{isCargo ? cargoQty.toFixed(0) : "—"}</td>
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
                      hintText={cueText.buyGoods[gid] ?? hintText}
                      recommendedBuyQty={suggestedBuyQty}
                      disabledReason={interactionLocked ? "Arrive before trading" : undefined}
                      onBuy={(qty) => buy(ship.id, gid, qty)}
                    />
                  </td>
                )}
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

function BuyControls({
  ship, world, goodId, stock, price, suggestedBuy, hintText, suggestionLabel, recommendedBuyQty, disabledReason, onBuy,
}: {
  ship: Trader; world: World; goodId: string; stock: number; price: number;
  suggestedBuy: boolean; hintText: string;
  suggestionLabel?: string;
  recommendedBuyQty?: number;
  disabledReason?: string;
  onBuy: (qty: number) => void;
}) {
  const good = world.goods[goodId];
  const totalMass = cargoMassFn(ship, world);
  const roomMass = ship.capacity - totalMass;
  const maxByRoom = Math.floor(roomMass / good.weight);
  const maxByFunds = price > 0 ? Math.floor(ship.funds / price) : 0;
  const maxBuy = Math.max(0, Math.min(maxByRoom, maxByFunds, Math.floor(stock)));

  const canBuy10 = disabledReason == null && maxBuy >= 10;
  const canBuyMax = disabledReason == null && maxBuy >= 1;

  let buyTitle = "";
  if (disabledReason) buyTitle = disabledReason;
  else if (stock < 1) buyTitle = "Out of stock here";
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
        onClick={(event) => {
          event.stopPropagation();
          onBuy(10);
        }}
        disabled={!canBuy10}
        title={canBuy10 ? "Buy 10" : (buyTitle || "Need room/funds/stock for at least 10")}
      >
        <span className="btn-label">+10</span>
      </button>
      <ActionCell suggested={suggestedBuy} hintText={hintText} label={suggestionLabel}>
        <button
          className={`btn-action ${suggestedBuy ? "btn-suggested" : "primary"}`}
          onClick={(event) => {
            event.stopPropagation();
            onBuy(buyClickQty);
          }}
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

function InfoAreaCard({ ship, world, loc, focus, pinnedFocuses, activePinnedKey, onSelectPinned, onClosePinned, onClearFocus, target, hint }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  focus: InfoFocus | null;
  pinnedFocuses: InfoFocus[];
  activePinnedKey: string | null;
  onSelectPinned: (key: string) => void;
  onClosePinned: (key: string) => void;
  onClearFocus: () => void;
  target: HintTarget;
  hint: GuidedHint;
}) {
  const requestedKey = infoPanelKey(focus);
  const requestedKind = infoPanelKind(focus);
  const [transition, setTransition] = useState<InfoPanelTransition>(() => ({
    renderedFocus: focus,
    renderedKey: requestedKey,
    renderedKind: requestedKind,
    pendingFocus: null,
    pendingKey: null,
    pendingKind: null,
    phase: "entering",
  }));

  if (transition.phase === "exiting") {
    if (requestedKind === transition.renderedKind) {
      setTransition({
        renderedFocus: focus,
        renderedKey: requestedKey,
        renderedKind: requestedKind,
        pendingFocus: null,
        pendingKey: null,
        pendingKind: null,
        phase: "idle",
      });
    } else if (requestedKey !== transition.pendingKey || requestedKind !== transition.pendingKind) {
      setTransition({
        ...transition,
        pendingFocus: focus,
        pendingKey: requestedKey,
        pendingKind: requestedKind,
      });
    }
  } else if (requestedKind !== transition.renderedKind) {
    setTransition({
      ...transition,
      pendingFocus: focus,
      pendingKey: requestedKey,
      pendingKind: requestedKind,
      phase: "exiting",
    });
  } else if (requestedKey !== transition.renderedKey) {
    setTransition({
      renderedFocus: focus,
      renderedKey: requestedKey,
      renderedKind: requestedKind,
      pendingFocus: null,
      pendingKey: null,
      pendingKind: null,
      phase: "idle",
    });
  }

  const renderedFocus = transition.renderedFocus;
  const stationLoc = renderedFocus?.kind === "station" ? world.locations[renderedFocus.loc] ?? loc : loc;
  const infoArtUrl = renderedFocus == null
    ? shipArtUrl(ship)
    : renderedFocus.kind === "station"
      ? stationArtUrl(stationLoc)
      : goodArtUrl(world, renderedFocus.good);
  const phaseClass = transition.phase === "idle" ? "" : `is-${transition.phase}`;
  const handleInfoAnimationEnd = (event: AnimationEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    setTransition(prev => {
      if (prev.phase === "exiting" && prev.pendingKey != null && prev.pendingKind != null) {
        return {
          renderedFocus: prev.pendingFocus,
          renderedKey: prev.pendingKey,
          renderedKind: prev.pendingKind,
          pendingFocus: null,
          pendingKey: null,
          pendingKind: null,
          phase: "entering",
        };
      }
      if (prev.phase === "entering") {
        return { ...prev, phase: "idle" };
      }
      return prev;
    });
  };

  return (
    <section
      className={`bridge-card trade-helper-card info-area-card ${infoArtUrl ? "art-card" : ""} ${phaseClass} ${renderedFocus == null || renderedFocus.kind === "station" ? "station-info-helper" : ""}`}
      style={infoArtUrl ? artCardStyle(infoArtUrl) : undefined}
    >
      <div
        className={`bridge-card-tabs info-area-tabs ${pinnedFocuses.length === 0 ? "empty" : ""}`}
        aria-label="Pinned info"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClearFocus();
        }}
      >
        {pinnedFocuses.length === 0 ? (
          <span className="info-area-tabs-empty">Click an entry to pin it</span>
        ) : pinnedFocuses.map(pinned => {
          const key = infoFocusKey(pinned);
          const active = requestedKey === key || (!focus && activePinnedKey === key);
          return (
            <div
              key={key}
              className={`bridge-tab info-area-tab ${active ? "active" : ""}`}
              title={infoFocusLabel(pinned, world)}
            >
              <button
                className="info-area-tab-main"
                onClick={() => onSelectPinned(key)}
              >
                <span>{infoFocusLabel(pinned, world)}</span>
              </button>
              <button
                className="info-area-tab-close"
                aria-label={`Close ${infoFocusLabel(pinned, world)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClosePinned(key);
                }}
              >
                x
              </button>
            </div>
          );
        })}
      </div>
      <div className={`info-area-content ${phaseClass}`} onAnimationEnd={handleInfoAnimationEnd}>
        <div key={transition.renderedKey} className="info-area-values">
          <div className="info-area-detail">
            {renderedFocus == null ? (
              <ShipInfoPanelContent ship={ship} world={world} />
            ) : renderedFocus.kind === "station" ? (
              <StationTradeHelperInfoContent loc={stationLoc} world={world} />
            ) : (
              <TradeGoodInfoContent ship={ship} world={world} loc={loc} focus={renderedFocus} target={target} hint={hint} />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function ShipInfoPanelContent({ ship, world }: { ship: Trader; world: World }) {
  const cargoUsed = cargoMassFn(ship, world);
  const installedCount = Object.keys(ship.upgrades ?? {}).length;
  const crewCount = Object.keys(ship.crew ?? {}).length;
  const fuelQty = ship.currentFuel?.qty ?? 0;
  const fuelName = ship.currentFuel ? world.goods[ship.currentFuel.good]?.name ?? ship.currentFuel.good : "No fuel";
  const debt = ship.maintenanceDebt ?? 0;
  const hullDamagePct = Math.max(0, Math.min(100, (debt / MAINTENANCE_DEBT_TRAVEL_BLOCK) * 100));
  const locationName = ship.state === "transit"
    ? world.locations[ship.destination!]?.name ?? ship.destination
    : world.locations[ship.location]?.name ?? ship.location;
  const wage = totalCrewWage(ship);

  return (
    <InfoPanelFrame
      eyebrow="Ship info"
      title={ship.name}
      badge={<span className="station-kind-pill station-kind-frontier">{ship.pilot}</span>}
      metaClassName="station-info-tags"
      meta={(
        <>
          <span>{ship.state}</span>
          <span>{locationName}</span>
          <span>{fuelName}</span>
        </>
      )}
    >
      {ship.state === "transit" && <TransitProgress ship={ship} world={world} />}

      <dl className="trade-helper-grid station-info-grid">
        <Stat label="wallet" value={`Ç${Math.round(ship.funds).toLocaleString()}`} />
        <Stat label="cargo" value={`${cargoUsed.toFixed(0)} / ${ship.capacity}`} />
        <Stat label="fuel" value={`${fuelQty.toFixed(0)} / ${ship.fuelCapacity}`} />
        <Stat label="hull damage" value={`${Math.round(hullDamagePct)}%`} />
        <Stat label="speed" value={ship.speed.toLocaleString()} />
        <Stat label="hull" value={(ship.hull ?? ship.baseHull ?? 1).toLocaleString()} />
      </dl>

      <div className="trade-helper-section">
        <div className="exchange-section-title">Systems</div>
        <div className="trade-helper-line">
          <span><IconLabel icon={GiFactory}>Upgrade slots</IconLabel></span>
          <span className="mono">{installedCount} / 5</span>
        </div>
        <div className="trade-helper-line">
          <span><IconLabel icon={GiAstronautHelmet}>Crew</IconLabel></span>
          <span className="mono">{crewCount} / 3</span>
        </div>
        <div className="trade-helper-line">
          <span><IconLabel icon={GiRadarSweep}>Weapons</IconLabel></span>
          <span className="mono">{(ship.weaponPower ?? ship.baseWeaponPower ?? 0).toLocaleString()}</span>
        </div>
      </div>

      <div className="trade-helper-section">
        <div className="exchange-section-title">Upkeep</div>
        <div className="trade-helper-line">
          <span>Service debt</span>
          <span className={`mono ${debt > 0 ? "warn" : ""}`}>Ç{Math.round(debt).toLocaleString()}</span>
        </div>
        <div className="trade-helper-line">
          <span>Crew wages</span>
          <span className="mono">Ç{Math.round(wage).toLocaleString()}/t</span>
        </div>
      </div>
    </InfoPanelFrame>
  );
}

function TradeGoodInfoContent({ ship, world, loc, focus, target, hint }: {
  ship: Trader; world: World; loc: LocationDef; focus: GoodInfoFocus; target: HintTarget; hint: GuidedHint;
}) {
  const market = world.markets[loc.id];
  const cargoGroups = groupCargoByGood(ship);
  const fallbackGood = focus.good;
  const good = world.goods[fallbackGood];
  if (!good || isUpgradeGood(fallbackGood)) return <StationTradeHelperInfoContent loc={loc} world={world} />;
  const stock = market.stock[fallbackGood] ?? 0;
  const price = market.prices[fallbackGood] ?? good.basePrice;
  const targetStock = loc.targetStock[fallbackGood] ?? 0;
  const stockPct = targetStock > 0 ? Math.max(0, Math.min(100, (stock / targetStock) * 100)) : 0;
  const stockTone = targetStock > 0 && stock < targetStock * 0.35 ? "warn" : targetStock > 0 && stock > targetStock * 1.2 ? "good" : "";
  const cargo = cargoGroups.find(g => g.good === fallbackGood) ?? null;
  const cargoFocused = focus.source === "cargo" && cargo != null;
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
    <InfoPanelFrame
      eyebrow="Trade helper"
      title={good.name}
      badge={isSuggested ? <span className="trade-helper-suggested">suggested</span> : null}
      meta={(
        <>
          <span>{good.category}</span>
          <span>{good.weight.toFixed(1)} mass/u</span>
          <span>{cargoFocused ? "cargo lot" : hint.kind.replace(/_/g, " ")}</span>
        </>
      )}
    >
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
    </InfoPanelFrame>
  );
}

function ShipCargoTabs({ ship, world, loc, groups, inTransit, target, hintText, cueText, cargoUsed, cargoPct, selectedGood, pinnedGoods, onSelectGood, onHoverGood }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  groups: CargoGroup[];
  inTransit: boolean;
  target: HintTarget;
  hintText: string;
  cueText: CueTextMap;
  cargoUsed: number;
  cargoPct: number;
  selectedGood: GoodId | null;
  pinnedGoods: Set<GoodId>;
  onSelectGood: (good: GoodId) => void;
  onHoverGood: (good: GoodId | null) => void;
}) {
  const [tab, setTab] = useState<"cargo" | "upgrades" | "crew">("cargo");
  const installedCount = Object.keys(ship.upgrades ?? {}).length;
  const crewCount = Object.keys(ship.crew ?? {}).length;
  const manualActions = ship.pilot !== "auto";
  const cargoSuggested = manualActions && targetSuggestsCargoAction(target);
  const cargoHintText = cueText.sections.cargo ?? hintText;

  return (
    <div className="ship-cargo-section">
      <div className="bridge-card-tabs ship-cargo-tabs">
        <button
          className={`bridge-tab ship-meter-tab cargo-meter-tab ${tab === "cargo" ? "active" : ""} ${cargoSuggested ? "has-suggestion" : ""}`}
          style={meterTabStyle(cargoPct)}
          onClick={() => setTab("cargo")}
          title={cargoSuggested ? cargoHintText : `${cargoPct.toFixed(0)}% cargo capacity used`}
        >
          Cargo
          <span className="bridge-tab-count">{cargoUsed.toFixed(0)}/{ship.capacity}</span>
        </button>
        <button
          className={`bridge-tab ${tab === "upgrades" ? "active" : ""}`}
          onClick={() => setTab("upgrades")}
        >
          Upgrades <span className="bridge-tab-count">{installedCount}/5</span>
        </button>
        <button
          className={`bridge-tab ${tab === "crew" ? "active" : ""}`}
          onClick={() => setTab("crew")}
        >
          Crew <span className="bridge-tab-count">{crewCount}/3</span>
        </button>
      </div>
      {tab === "cargo" && (
        <CargoTab
          ship={ship}
          world={world}
          loc={loc}
          groups={groups}
          inTransit={inTransit}
          target={target}
          hintText={hintText}
          cueText={cueText}
          selectedGood={selectedGood}
          pinnedGoods={pinnedGoods}
          onSelectGood={onSelectGood}
          onHoverGood={onHoverGood}
        />
      )}
      {tab === "upgrades" && <ShipUpgradesTab ship={ship} />}
      {tab === "crew" && <CrewTab ship={ship} />}
    </div>
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
  return da.tier - db.tier
    || UPGRADE_SLOT_RANK[da.slot] - UPGRADE_SLOT_RANK[db.slot]
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
          <col className="col-tier" />
          <col className="col-role" />
          <col />
          <col />
        </colgroup>
        <thead>
          <tr>
            <th>Tier</th>
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
                <td>{def ? <span className={`tier-badge tier-${tierClass(def.tier)}`}>T{def.tier}</span> : <span className="faint">—</span>}</td>
                <td className="dim"><IconLabel icon={Icon}>{label}</IconLabel></td>
                <td>
                  {def ? (
                    <span className="upgrade-name">{def.name}</span>
                  ) : (
                    <span className="faint">open</span>
                  )}
                </td>
                <td className="dim upgrade-effect">{def ? upgradeEffectText(def) : "No modifier"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="upgrade-offer-title dim">Cargo modules</div>
      <table className="upgrade-table upgrade-offers-table">
        <colgroup>
          <col className="col-tier" />
          <col className="col-source" />
          <col />
          <col className="col-role" />
          <col />
          <col className="col-num" />
          <col className="col-action" />
        </colgroup>
        <thead>
          <tr>
            <th>Tier</th>
            <th>Source</th>
            <th>Module</th>
            <th>Slot</th>
            <th>Effect</th>
            <th className="numeric">Qty</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {cargoUpgrades.length === 0 ? (
            <tr>
              <td colSpan={7} className="upgrade-row-empty">
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
                    <td><span className={`tier-badge tier-${tierClass(def.tier)}`}>T{def.tier}</span></td>
                    <td><span className="upgrade-source-pill">Cargo</span></td>
                    <td>
                      <span className="upgrade-name">{def.name}</span>
                    </td>
                    <td className="dim"><IconLabel icon={Icon}>{UPGRADE_SLOTS.find(s => s.slot === def.slot)?.label ?? def.slot}</IconLabel></td>
                    <td className="dim upgrade-effect">{upgradeEffectText(def)}</td>
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

function StationUpgradePurchaseTab({ ship, world, loc, target, hintText, cueText, interactionLocked }: {
  ship: Trader; world: World; loc: LocationDef; target: HintTarget; hintText: string; cueText: CueTextMap; interactionLocked: boolean;
}) {
  const buy = useStore((s) => s.buy);
  const docked = ship.state === "idle" && ship.location === loc.id && !interactionLocked;
  const market = world.markets[loc.id];
  const stationUpgradeIds = market
    ? Object.keys(world.goods)
      .filter(g => isUpgradeGood(g) && (market.stock[g] ?? 0) >= 1)
      .sort(compareUpgradeGoods)
    : [];
  const totalMass = cargoMassFn(ship, world);
  const roomMass = ship.capacity - totalMass;

  return (
    <table className="upgrade-table upgrade-offers-table">
        <colgroup>
          <col className="col-tier" />
          <col />
          <col className="col-role" />
          <col />
          <col className="col-num" />
          <col className="col-num" />
          <col className="col-action" />
        </colgroup>
        <thead>
          <tr>
            <th>Tier</th>
            <th>Module</th>
            <th>Slot</th>
            <th>Effect</th>
            <th className="numeric">Stock</th>
            <th className="numeric">Cost</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {stationUpgradeIds.length === 0 ? (
            <tr>
              <td colSpan={7} className="upgrade-row-empty">
                No upgrade modules stocked at this station.
              </td>
            </tr>
          ) : (
            stationUpgradeIds.map((goodId) => {
              const def = upgradeDef(goodId)!;
              const Icon = UPGRADE_SLOT_ICONS[def.slot];
              const good = world.goods[goodId];
              const price = market ? marketQuote(world, loc.id, goodId) : good.basePrice;
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
                <tr key={goodId} className="upgrade-offer-row">
                  <td><span className={`tier-badge tier-${tierClass(def.tier)}`}>T{def.tier}</span></td>
                  <td>
                    <span className="upgrade-name">{def.name}</span>
                  </td>
                  <td className="dim"><IconLabel icon={Icon}>{UPGRADE_SLOTS.find(s => s.slot === def.slot)?.label ?? def.slot}</IconLabel></td>
                  <td className="dim upgrade-effect">{upgradeEffectText(def)}</td>
                  <td className="numeric mono">{stock.toFixed(0)}</td>
                  <td className="numeric mono">Ç{Math.round(price).toLocaleString()}</td>
                  <td>
                    <ActionCell suggested={suggested} hintText={cueText.buyGoods[goodId] ?? hintText}>
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
  );
}

function CargoTab({ ship, world, loc, groups, inTransit, target, hintText, cueText, selectedGood, pinnedGoods, onSelectGood, onHoverGood }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  groups: CargoGroup[];
  inTransit: boolean;
  target: HintTarget;
  hintText: string;
  cueText: CueTextMap;
  selectedGood: GoodId | null;
  pinnedGoods: Set<GoodId>;
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
              hintText={cueText.sellGoods[g.good] ?? hintText}
              selected={selectedGood === g.good}
              pinned={pinnedGoods.has(g.good)}
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

function CargoRow({ group, ship, world, refLocId, inTransit, suggested, hintText, selected, pinned, showAction, onSelect, onHover, onSell }: {
  group: CargoGroup;
  ship: Trader;
  world: World;
  refLocId: string;
  inTransit: boolean;
  suggested: boolean;
  hintText: string;
  selected: boolean;
  pinned: boolean;
  showAction: boolean;
  onSelect: () => void;
  onHover: (good: GoodId | null) => void;
  onSell: () => void;
}) {
  const good = world.goods[group.good];
  const herePrice = marketQuote(world, refLocId, group.good);
  const hereNetUnit = herePrice * (1 - SALES_TAX_RATE);
  const hereNetRevenue = group.totalQty * hereNetUnit;
  const pnl = hereNetRevenue - group.totalCost;
  const pnlPct = group.totalCost > 0 ? (pnl / group.totalCost) * 100 : 0;
  const pnlTone = pnl > 0 ? "good" : pnl < 0 ? "bad" : "dim";
  const canSell = ship.state === "idle" && group.totalQty > 0;

  return (
    <tr
      className="cargo-row"
      aria-selected={selected}
    >
      <td>
        <button
          type="button"
          className="row-title-with-pin info-focus-trigger"
          aria-pressed={pinned}
          onMouseEnter={() => onHover(group.good)}
          onMouseLeave={() => onHover(null)}
          onFocus={() => onHover(group.good)}
          onBlur={() => onHover(null)}
          onClick={onSelect}
        >
          <span className="cargo-row-name">{good.name}</span>
          {pinned && <MdPushPin className="ui-icon row-pin-icon" aria-hidden="true" focusable="false" />}
        </button>
        {group.lots.length > 1 && <span className="row-meta-pill cargo-row-lots">{group.lots.length} lots</span>}
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
  const roles: { role: CrewRole; label: string }[] = [
    { role: "captain",   label: "Pilot" },
    { role: "navigator", label: "Navigator" },
    { role: "mechanic",  label: "Mechanic" },
  ];

  return (
    <table className="crew-table">
      <colgroup>
        <col className="col-tier" />
        <col className="col-role" />
        <col />
        <col className="col-num" />
        <col className="col-action" />
      </colgroup>
      <thead>
        <tr>
          <th>Tier</th>
          <th>Role</th>
          <th>Crew</th>
          <th className="numeric">Wage</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {roles.map(({ role, label }) => {
          const member = ship.crew?.[role];
          const mods = member ? modifiersText(member.modifiers) : "";
          return (
            <tr key={role} className="crew-row">
              <td>{member ? <span className={`tier-badge tier-${tierClass(member.tier)}`}>T{member.tier}</span> : <span className="faint">—</span>}</td>
              <td className="dim">{label}</td>
              <td>
                {member ? (
                  <>
                    <span className="crew-name">{member.name}</span>
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
function ActiveContractsTab({ ship, world, jobs, target, cueText, hintText }: {
  ship: Trader; world: World; jobs: Job[]; target: HintTarget; cueText: CueTextMap; hintText: string;
}) {
  const abandonJob = useStore((s) => s.abandonJob);
  const collectJob = useStore((s) => s.collectJob);
  const sorted = [...jobs].sort((a, b) => {
    const tierRank: Record<typeof a.tier, number> = { high: 0, medium: 1, low: 2 };
    return Number(b.kind === "trade") - Number(a.kind === "trade")
      || tierRank[a.tier] - tierRank[b.tier]
      || a.expiresAt - b.expiresAt;
  });
  return (
    <>
      {sorted.length === 0 ? (
        <div className="contract-empty">No active contracts.</div>
      ) : (
        <table className="jobs-table contract-table active-contracts-table">
          <colgroup>
            <col className="col-tier" />
            <col />
            <col className="col-dest" />
            <col className="col-progress" />
            <col className="col-money" />
            <col className="col-money" />
            <col className="col-expires" />
            <col className="col-action" />
          </colgroup>
          <thead>
            <tr>
              <th>Tier</th>
              <th>Contract</th>
              <th>Route</th>
              <th>Progress</th>
              <th className="numeric">Reward</th>
              <th className="numeric">Penalty</th>
              <th className="numeric">Expires</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((j) => {
              const ticksLeft = Math.max(0, j.expiresAt - world.tick);
              const expiringSoon = ticksLeft <= 10;
              const dst = world.locations[j.destination]?.name ?? j.destination;
              const isTradeJob = j.kind === "trade";
              const good = isTradeJob
                ? `${j.trade?.ticker ?? "Trade"} settlement`
                : j.good ? world.goods[j.good]?.name ?? j.good : "Contract";
              const away = j.destination !== ship.location;
              const pct = j.qty > 0 ? Math.max(0, Math.min(100, (j.delivered / j.qty) * 100)) : 0;
              const suggestedCollect = target.collectJobId === j.id && j.destination === ship.location;
              return (
                <tr key={j.id} className={`contract-row contract-tier-${j.tier}`}>
                  <td><span className={`tier-badge tier-${j.tier}`}>{j.tier.toUpperCase()}</span></td>
                  <td>
                    <span className="contract-title-row">
                      <span className="contract-good">{good}</span>
                      {j.kind === "rescue" && <span className="job-kind-tag">rescue</span>}
                      {isTradeJob && (
                        <span className="job-kind-tag">
                          {j.trade?.settlementKind === "loss_forgiveness" ? "loss review" : "trade"}
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="dim mono">{away ? `to ${dst}` : "here"}</td>
                  <td>
                    {isTradeJob ? (
                      <span className={`mono ${away ? "dim" : "good"}`}>{away ? "travel" : "ready"}</span>
                    ) : (
                      <div className="contract-progress">
                        <div className="contract-progress-bar">
                          <div className="contract-progress-fill" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="mono dim">{j.delivered.toFixed(0)}/{j.qty}</span>
                      </div>
                    )}
                  </td>
                  <td className="numeric mono good">Ç{j.reward.toLocaleString()}</td>
                  <td className={`numeric mono ${j.penalty > 0 ? "bad" : "faint"}`}>{j.penalty > 0 ? `Ç${j.penalty.toLocaleString()}` : "—"}</td>
                  <td className={`numeric mono ${expiringSoon ? "warn" : "dim"}`}>{ticksLeft}t</td>
                  <td>
                    {isTradeJob ? (
                      <ActionCell suggested={suggestedCollect} hintText={cueText.collectJobs[j.id] ?? hintText} label="Collect">
                        <button
                          className={`btn-action ${suggestedCollect ? "btn-suggested" : "primary"}`}
                          onClick={() => collectJob(j.id, ship.id)}
                          disabled={away}
                          title={away ? `Collect at ${dst}` : undefined}
                        >
                          <span className="btn-label">Collect</span>
                        </button>
                      </ActionCell>
                    ) : (
                      <button
                        className="btn-action"
                        onClick={() => abandonJob(j.id)}
                        title={j.penalty > 0 ? `Abandoning costs Ç${j.penalty.toLocaleString()}` : "Abandon (no penalty)"}
                      >
                        <span className="btn-label">Abandon</span>
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}

// "Hire offers" sits next to Market in the bottom split — same tabbed pattern
// as Cargo|Crew above. Lists posted offers at the docked station with their
// expiry countdown; rows are sorted tier asc / cost asc by listHiresAt.
function HireOffersTab({ ship, world, loc, interactionLocked }: { ship: Trader; world: World; loc: LocationDef; interactionLocked: boolean }) {
  const hire = useStore((s) => s.hireCrew);
  const offers = listHiresAt(world, loc.id);
  const docked = ship.state === "idle" && ship.location === loc.id && !interactionLocked;

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
          <tr><td colSpan={7} className="jobs-row-empty">No crew posted at {loc.name}.</td></tr>
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
  captain: "Pilot", navigator: "Navigator", mechanic: "Mechanic",
};

function tierClass(tier: number): "high" | "medium" | "low" {
  // Reuse the jobs tier coloring so T3 = hot/expensive (red), T1 = baseline.
  return tier >= 3 ? "high" : tier === 2 ? "medium" : "low";
}

function TravelOptions({ ship, world, loc, target, hintText, cueText, selectedStation, pinnedStations, inTransit, onSelectStation, onHoverStation, onPulseSuggestions }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  target: HintTarget;
  hintText: string;
  cueText: CueTextMap;
  selectedStation: LocationId | null;
  pinnedStations: Set<LocationId>;
  inTransit: boolean;
  onSelectStation: (station: LocationId) => void;
  onHoverStation: (station: LocationId | null) => void;
  onPulseSuggestions: () => void;
}) {
  const travel = useStore((s) => s.travel);
  const stepN = useStore((s) => s.stepN);
  const [armedDepart, setArmedDepart] = useState<LocationId | null>(null);
  const departGuardTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (departGuardTimer.current != null) window.clearTimeout(departGuardTimer.current);
  }, []);
  const manualActions = ship.pilot !== "auto";
  const ft = ship.fuelTypes.find(f => f.good === ship.currentFuel?.good);
  const fuel = ship.currentFuel?.qty ?? 0;
  const routeFrom = inTransit ? loc.id : ship.location;
  const market = world.markets[routeFrom];
  const activeJobsByDestination = new Map<string, Job[]>();
  for (const job of Object.values(world.jobs)) {
    if (job.acceptedBy !== ship.id) continue;
    const jobs = activeJobsByDestination.get(job.destination) ?? [];
    jobs.push(job);
    activeJobsByDestination.set(job.destination, jobs);
  }
  const contractLine = (jobs: Job[]) => {
    const first = jobs.slice(0, 2).map(j => {
      if (j.kind === "trade") return `${j.trade?.ticker ?? "Trade"} settlement`;
      const name = j.good ? world.goods[j.good]?.name ?? j.good : "Contract";
      return `${name} ${Math.max(0, j.qty - j.delivered).toFixed(0)}`;
    });
    const more = jobs.length > 2 ? ` +${jobs.length - 2}` : "";
    return `${jobs.length} active: ${first.join(", ")}${more}`;
  };

  const dests = reachableNeighbors(world, routeFrom)
    .map(({ to, dist }) => {
      const dst = world.locations[to];
      const fuelNeeded = ft ? dist * effectivePerDistance(ship, ft.perDistance) : 0;
      const fuelCost = ft ? fuelNeeded * (market.prices[ft.good] ?? 0) : 0;
      const travelTicks = Math.max(1, Math.ceil(dist / ship.speed));
      const canFly = ft != null && fuel >= fuelNeeded;
      return { to, name: dst?.name ?? to, dist, fuelNeeded, fuelCost, travelTicks, canFly };
    })
    .sort((a, b) => a.dist - b.dist);
  const travelSuggested = !inTransit && manualActions && dests.some(d => target.travelTo === d.to && d.canFly);
  const travelHintText = target.travelTo ? cueText.travel[target.travelTo] ?? cueText.sections.travel ?? hintText : hintText;
  const quickTravelTab = inTransit && manualActions ? (
    <button
      className="travel-panel-action"
      onClick={() => stepN(ship.ticksRemaining)}
      title={`Advance ${ship.ticksRemaining} ticks until arrival`}
    >
      Quick Travel <span className="bridge-tab-count">{ship.ticksRemaining}t</span>
    </button>
  ) : null;
  const travelTitle = inTransit ? "Arrival route" : "Stations";
  const travelSubtitle = inTransit
    ? `In transit to ${world.locations[ship.destination ?? loc.id]?.name ?? loc.name} / ${ship.ticksRemaining} tick${ship.ticksRemaining === 1 ? "" : "s"} remaining`
    : `${dests.length} reachable station${dests.length === 1 ? "" : "s"}, departing ${world.locations[routeFrom]?.name ?? loc.name}`;

  return (
    <section className="bridge-card travel-card">
      <header className={`travel-panel-head ${travelSuggested ? "has-suggestion" : ""}`} title={travelSuggested ? travelHintText : undefined}>
        <div>
          <span className="travel-panel-label">{travelTitle}</span>
          <span className="travel-panel-subtitle dim">{travelSubtitle}</span>
        </div>
        {quickTravelTab}
      </header>
      <table className={`travel-table ${!manualActions ? "travel-table-readonly" : ""} ${inTransit ? "transit-preview-content" : ""}`}>
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
            const pinned = pinnedStations.has(d.to);
            const departGuarded = !inTransit && d.canFly && shouldGuardDepartureForSuggestions(world, target, d.to, ship);
            const departArmed = armedDepart === d.to;
            return (
              <tr
                key={d.to}
                className={destinationJobs.length > 0 ? "travel-has-contract" : ""}
                aria-selected={selectedStation === d.to}
              >
                <td>
                  <div className="travel-dest-cell">
                    <button
                      type="button"
                      className="row-title-with-pin travel-dest-title info-focus-trigger"
                      aria-pressed={pinned}
                      onMouseEnter={() => onHoverStation(d.to)}
                      onMouseLeave={() => onHoverStation(null)}
                      onFocus={() => onHoverStation(d.to)}
                      onBlur={() => onHoverStation(null)}
                      onClick={() => onSelectStation(d.to)}
                    >
                      <span className="travel-dest-name">{d.name}</span>
                      {pinned && <MdPushPin className="ui-icon row-pin-icon" aria-hidden="true" focusable="false" />}
                    </button>
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
                    <ActionCell suggested={!inTransit && suggested && d.canFly} hintText={cueText.travel[d.to] ?? hintText}>
                      <button
                        onClick={(event) => {
                          event.stopPropagation();
                          if (departGuarded && !departArmed) {
                            setArmedDepart(d.to);
                            onPulseSuggestions();
                            if (departGuardTimer.current != null) window.clearTimeout(departGuardTimer.current);
                            departGuardTimer.current = window.setTimeout(() => {
                              setArmedDepart(current => current === d.to ? null : current);
                              departGuardTimer.current = null;
                            }, DEPART_SUGGESTION_GUARD_MS);
                            return;
                          }
                          if (departGuardTimer.current != null) {
                            window.clearTimeout(departGuardTimer.current);
                            departGuardTimer.current = null;
                          }
                          setArmedDepart(null);
                          travel(ship.id, d.to);
                        }}
                        disabled={inTransit || !d.canFly}
                        className={`btn-action ${!inTransit && suggested && d.canFly ? "btn-suggested" : ""} ${departArmed ? "depart-armed" : ""}`}
                        title={inTransit ? "Arrive before plotting another trip" : d.canFly ? departArmed ? "Click again to depart with suggested actions still pending" : "" : "Insufficient fuel for this trip"}
                      >
                        <span className="btn-label">{departArmed ? "Confirm" : "Depart"}</span>
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
