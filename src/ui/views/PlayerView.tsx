import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { IconType } from "react-icons";
import {
  GiAstronautHelmet,
  GiAutoRepair,
  GiCargoCrate,
  GiContract,
  GiFactory,
  GiFuelTank,
  GiPathDistance,
  GiProcessor,
  GiRadarSweep,
  GiSpeedometer,
  GiCrossedSwords,
  GiTrade,
} from "react-icons/gi";
import { useStore, type FleetTab } from "../store";
import { useIsMobile } from "../useIsMobile";
import { defaultMobilePanelId } from "../mobilePanels";
import { distance, reachableNeighbors } from "../../sim/geometry";
import { describeHint, getGuidedPlan, hintTarget, type GuidedHint, type GuidedPlan, type HintTarget } from "../../sim/suggestions";
import { DOCKING_FEE_PER_CAPACITY, MAINTENANCE_PER_CAPACITY, SALES_TAX_RATE } from "../../sim/economy";
import { marketQuote } from "../../sim/pricing";
import { cargoMass as cargoMassFn, findCargoLot, groupCargoByGood, type CargoGroup } from "../../sim/cargo";
import { listLocalJobs } from "../../sim/jobs";
import { ControlShareBar } from "../components/ControlShareBar";
import "./LocationsView.css"; // for .atlas-control-bar styles, used by ControlShareBar
import { effectivePerDistance, hasCrew, ignoresFuel, totalCrewWage, travelTicksFor } from "../../sim/crew";
import { MAINTENANCE_DEBT_TRAVEL_BLOCK } from "../../sim/crew";
import { listHiresAt } from "../../sim/hires";
import { listShipyardInventory } from "../../sim/shipyards";
import { hullRepairCost, selectRefuelType, UNLOAD_TICKS, unloadTicksRemainingFor } from "../../sim/traders";
import { UPGRADE_SLOTS, installedUpgrade, isUpgradeGood, upgradeDef, upgradeEffectText } from "../../sim/upgrades";
import type { CrewModifiers, CrewRole, Equity } from "../../sim/types";
import type { CrewMember, GoodId, Job, JobId, LocationDef, LocationId, ShipBlueprint, ShipLogEntry, ShipTrait, StockPosition, Trader, TraderId, UpgradeSlot, World } from "../../sim/types";
import { parseBasisUnderlying, priceChangePct } from "../../sim/stock";
import { useCrewHeadshot } from "../headshots";
import { goodArtUrl, shipArtUrl, stationArtUrl, stationKind, stationKindLabel, stationScale, stationScaleLabel, stationSubtype, stationSubtypeLabel } from "../art";
import { useBlueprintArtImageUrl, useShipArtImageUrl } from "../shipArtApi";
import { SortableRows, SortableTh } from "../components/SortableTable";
import { MiniSparkline } from "../components/MiniSparkline";
import { BuyShipModal } from "../components/BuyShipModal";
import "./PlayerView.css";

const SHOW_DEV_SHIP_PLAN_PANEL = false;
const SHOW_DEV_SHIP_LOG_PANEL = false;
const GUIDANCE_LOCKED_TEXT = "Hire a navigator for guided suggestions.";
const DEPART_SUGGESTION_GUARD_MS = 1800;
const SUGGESTION_PULSE_MS = 3700;
// Ship card and exchange card share the canonical FleetTab in the
// store, so opening one side syncs the other (cargo↔market,
// upgrades↔upgrades, crew↔offers, contracts↔contracts).
type ShipCargoTab = FleetTab;
type ExchangeTab = "markets" | "upgrades" | "offers" | "contracts";

function fleetTabToExchangeTab(tab: FleetTab): ExchangeTab {
  if (tab === "cargo") return "markets";
  if (tab === "crew") return "offers";
  return tab;
}

function exchangeTabToFleetTab(tab: ExchangeTab): FleetTab {
  if (tab === "markets") return "cargo";
  if (tab === "offers") return "crew";
  return tab;
}
const INFO_HOVER_CLEAR_DELAY_MS = 90;

export function PlayerView() {
  const world = useStore((s) => s.world);
  useStore((s) => s.tickEpoch);
  const selectedTrader = useStore((s) => s.selectedTrader);
  const lastError = useStore((s) => s.lastError);
  const clearError = useStore((s) => s.clearError);
  const isMobile = useIsMobile();
  const mobilePanel = useStore(s => s.mobilePanel.player ?? defaultMobilePanelId("player") ?? "fleet");

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
    <section
      className={`player-view ${isMobile ? "mobile" : ""}`}
      data-mobile-panel={isMobile ? mobilePanel : undefined}
    >
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
  suggested: boolean;
  hintText: string;
  critical?: boolean;
  label?: string;
  children: ReactNode;
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
// Ship blueprint hover/click focus — only set when a shipyard's
// marketplace row is the active row in the markets table. The info
// panel renders blueprint-shaped content, not goods-shaped content.
type ShipBlueprintInfoFocus = { kind: "ship-blueprint"; blueprintId: string };
type InfoFocus = GoodInfoFocus | StationInfoFocus | ShipBlueprintInfoFocus;

function infoFocusKey(focus: InfoFocus): string {
  if (focus.kind === "good") return `good:${focus.source}:${focus.good}`;
  if (focus.kind === "ship-blueprint") return `blueprint:${focus.blueprintId}`;
  return `station:${focus.loc}`;
}

function infoPanelKey(focus: InfoFocus | null): string {
  return focus ? infoFocusKey(focus) : "ship-info";
}

function infoFocusLabel(focus: InfoFocus, world: World): string {
  if (focus.kind === "good") {
    const name = world.goods[focus.good]?.name ?? focus.good;
    return focus.source === "cargo" ? `${name} cargo` : name;
  }
  if (focus.kind === "ship-blueprint") {
    const bp = findBlueprintEverywhere(world, focus.blueprintId);
    return bp ? `${bp.name} (${bp.classLabel})` : focus.blueprintId;
  }
  return world.locations[focus.loc]?.name ?? focus.loc;
}

function infoFocusRowClass(pinned: boolean, extra = ""): string {
  return `info-focus-row ${pinned ? "is-pinned" : ""} ${extra}`.trim();
}

function eventTargetsRowControl(event: { target: EventTarget; currentTarget: HTMLElement }): boolean {
  if (!(event.target instanceof Element)) return false;
  const control = event.target.closest(
    "button, a, input, select, textarea, summary, [contenteditable='true'], [role='button'], [tabindex]:not([tabindex='-1']), [data-row-action-cell]",
  );
  return control != null && control !== event.currentTarget;
}

function handleInfoRowKeyDown(event: KeyboardEvent<HTMLTableRowElement>, onSelect: () => void) {
  if (eventTargetsRowControl(event)) return;
  if (event.key !== "Enter" && event.key !== " ") return;
  event.preventDefault();
  onSelect();
}

// Helper for label lookup — the focus only carries a blueprint id; the
// blueprint itself lives in world.shipyardInventory keyed by station.
function findBlueprintEverywhere(world: World, id: string) {
  for (const list of Object.values(world.shipyardInventory ?? {})) {
    const bp = list.find(b => b.id === id);
    if (bp) return bp;
  }
  return null;
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
  const pinnedBlueprintIds = new Set<string>();
  for (const pinned of pinnedFocuses) {
    if (pinned.kind === "station") pinnedStations.add(pinned.loc);
    else if (pinned.kind === "good" && pinned.source === "cargo") pinnedCargoGoods.add(pinned.good);
    else if (pinned.kind === "good") pinnedMarketGoods.add(pinned.good);
    else if (pinned.kind === "ship-blueprint") pinnedBlueprintIds.add(pinned.blueprintId);
  }

  const pulseClass = suggestionPulse === 0
    ? ""
    : suggestionPulse === 1
      ? "suggestion-pulse-odd"
      : "suggestion-pulse-even";

  return (
    <div className={`docked-view ${pulseClass}`}>
      <div className="bridge">
        <div className="bridge-column bridge-left">
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
          <StationExchangeCard
            ship={ship}
            world={world}
            loc={loc}
            target={target}
            hintText={hintText}
            cueText={cueText}
            selectedGood={activeFocus?.kind === "good" && activeFocus.source === "market" ? activeFocus.good : null}
            pinnedGoods={pinnedMarketGoods}
            selectedBlueprintId={activeFocus?.kind === "ship-blueprint" ? activeFocus.blueprintId : null}
            pinnedBlueprintIds={pinnedBlueprintIds}
            inTransit={inTransit}
            onSelectGood={(good) => togglePinnedFocus({ kind: "good", good, source: "market" })}
            onHoverGood={(good) => {
              if (good) setHoverFocus({ kind: "good", good, source: "market" });
              else clearHoverFocus();
            }}
            onSelectBlueprint={(id) => togglePinnedFocus({ kind: "ship-blueprint", blueprintId: id })}
            onHoverBlueprint={(id) => {
              if (id) setHoverFocus({ kind: "ship-blueprint", blueprintId: id });
              else clearHoverFocus();
            }}
          />
        </div>
        <div className="bridge-column bridge-right">
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
      </div>
      {SHOW_DEV_SHIP_LOG_PANEL && <ShipLogCard ship={ship} />}
    </div>
  );
}

function ShipLogCard({ ship }: { ship: Trader }) {
  const entries = ship.log ?? [];
  return (
    <section className="bridge-card ship-log-card">
      <header className="bridge-card-head">
        <div className="bridge-card-title">
          <span className="bridge-card-eyebrow ship-eyebrow">Log</span>
          <span className="dim mono">{ship.name}</span>
        </div>
        <span className="dim mono">{entries.length} entries</span>
      </header>
      {entries.length === 0 ? (
        <p className="ship-log-empty dim">No actions yet. Buy, sell, refuel, travel, or accept a contract — they'll all show up here.</p>
      ) : (
        <PaginatedLogList entries={entries} scrollKey={`fleet:${ship.id}:log`} />
      )}
    </section>
  );
}

const LOG_PAGE_SIZE = 100;

// Newest-first paginated log. Renders the most recent LOG_PAGE_SIZE entries
// initially; an IntersectionObserver on a sentinel at the bottom expands by
// LOG_PAGE_SIZE more whenever the user scrolls into view of the sentinel.
// Resets the visible count when entries identity changes (different ship).
function PaginatedLogList({ entries, scrollKey }: { entries: ShipLogEntry[]; scrollKey: string }) {
  const [visibleCount, setVisibleCount] = useState(LOG_PAGE_SIZE);
  const sentinelRef = useRef<HTMLLIElement | null>(null);

  // Reset the window when the underlying list changes identity (different
  // ship picked, or game reloaded). Length-only changes (new entries
  // appended) don't reset — newest is at the top so the user keeps the
  // expansion they already chose.
  const entriesRef = useRef(entries);
  if (entriesRef.current !== entries) {
    entriesRef.current = entries;
    // Bumps via a ref rather than a state-set during render — visibleCount
    // doesn't need to change unless entries identity actually flipped.
  }
  useEffect(() => {
    setVisibleCount(LOG_PAGE_SIZE);
  }, [scrollKey]);

  const total = entries.length;
  const sliceStart = Math.max(0, total - visibleCount);
  // Newest-first display: take the tail of `entries` (most recent N) and
  // reverse so the freshest is at the top.
  const visible = entries.slice(sliceStart).reverse();
  const hasMore = sliceStart > 0;

  useEffect(() => {
    if (!hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisibleCount(c => Math.min(c + LOG_PAGE_SIZE, total));
        }
      },
      { rootMargin: "200px" },
    );
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [hasMore, total]);

  return (
    <ol className="ship-log-list" data-scroll-key={scrollKey}>
      {visible.map((e, i) => (
        <li key={`${e.tick}-${i}`} className={`ship-log-entry ${e.tone ? `tone-${e.tone}` : ""}`}>
          <span className="ship-log-tick mono dim">t{e.tick}</span>
          <span className="ship-log-kind">{e.kind.replace(/_/g, " ")}</span>
          <span className="ship-log-msg">{e.message}</span>
        </li>
      ))}
      {hasMore && (
        <li ref={sentinelRef} className="ship-log-loading dim">Loading older entries…</li>
      )}
    </ol>
  );
}

function ContractsTab({ ship, world, loc, target, hintText, cueText, interactionLocked }: {
  ship: Trader; world: World; loc: LocationDef; target: HintTarget; hintText: string; cueText: CueTextMap; interactionLocked: boolean;
}) {
  const acceptJob = useStore((s) => s.acceptJob);
  const manualActions = ship.pilot !== "auto";
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
        <SortableRows
          rows={jobs}
          columns={[
            { id: "tier", label: "tier", getValue: j => TIER_RANK[j.tier] },
            { id: "contract", label: "contract", getValue: j => j.good ? world.goods[j.good]?.name ?? j.good : j.kind },
            { id: "qty", label: "quantity", getValue: j => j.qty, defaultDirection: "desc" },
            { id: "held", label: "held cargo", getValue: j => j.good ? ship.cargo.filter(l => l.good === j.good).reduce((s, l) => s + l.qty, 0) : 0, defaultDirection: "desc" },
            { id: "reward", label: "reward", getValue: j => j.reward, defaultDirection: "desc" },
            { id: "penalty", label: "penalty", getValue: j => j.penalty, defaultDirection: "desc" },
            { id: "expires", label: "expiry", getValue: j => Math.max(0, j.expiresAt - world.tick) },
          ]}
        >
          {(sortedJobs, sort) => (
            <table className="jobs-table contract-table available-contracts-table">
              <colgroup>
                <col className="col-tier" />
                <col />
                <col className="col-num" />
                <col className="col-held" />
                <col className="col-money" />
                <col className="col-money" />
                <col className="col-expires" />
                {manualActions && <col className="col-action" />}
              </colgroup>
              <thead>
                <tr>
                  <SortableTh sort={sort} columnId="tier">Tier</SortableTh>
                  <SortableTh sort={sort} columnId="contract">Contract</SortableTh>
                  <SortableTh sort={sort} columnId="qty" className="numeric">Qty</SortableTh>
                  <SortableTh sort={sort} columnId="held" className="numeric">Held</SortableTh>
                  <SortableTh sort={sort} columnId="reward" className="numeric">Reward</SortableTh>
                  <SortableTh sort={sort} columnId="penalty" className="numeric">Penalty</SortableTh>
                  <SortableTh sort={sort} columnId="expires" className="numeric">Expires</SortableTh>
                  {manualActions && <th></th>}
                </tr>
              </thead>
              <tbody>
                {sortedJobs.map((j) => (
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
        </SortableRows>
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
          {job.postedBy && (() => {
            const synd = world.syndicates[job.postedBy];
            if (!synd) return null;
            const accent = synd.accentHex ?? "#9bb6c8";
            return (
              <span
                className="job-syndicate-tag"
                style={{ borderColor: accent, color: accent } as CSSProperties}
                title={`Posted by ${synd.name} — completion earns reputation + control`}
              >
                {synd.name}
              </span>
            );
          })()}
        </span>
      </td>
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
  const totalTicks = Math.max(1, travelTicksFor(ship, tripDist));
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
  meta?: ReactNode;
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

        {meta != null && (
          <div className={`trade-helper-meta ${metaClassName}`}>
            {meta}
          </div>
        )}
      </div>

      <div className="info-panel-scroll" data-scroll-key={`fleet:info:${eyebrow}:${title}`}>
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

  const factionId = loc.traits.faction;
  const factionSyndicate = factionId ? world.syndicates[factionId] : null;
  return (
    <InfoPanelFrame
      eyebrow="Station info"
      title={loc.name}
      badge={<span className={`station-kind-pill station-kind-${kind}`}>{stationKindLabel(kind)}</span>}
      metaClassName="station-info-tags"
      meta={(
        <>
          {factionSyndicate && (
            <span
              className="station-info-faction-tag"
              style={factionSyndicate.accentHex ? { borderColor: factionSyndicate.accentHex, color: factionSyndicate.accentHex } as CSSProperties : undefined}
              title={`Controlled by ${factionSyndicate.name}`}
            >
              {factionSyndicate.name}
            </span>
          )}
          {subtype && <span>{stationSubtypeLabel(subtype)}</span>}
          <span>{stationScaleLabel(scale)}</span>
          {loc.traits.tags.map(t => <span key={t}>{t}</span>)}
        </>
      )}
    >
      <ControlShareBar world={world} locId={loc.id} />
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

      <StationExchangeSection loc={loc} world={world} />


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
          <SortableRows
            rows={pressureRows}
            columns={[
              { id: "good", label: "good", getValue: row => row.name },
              { id: "stock", label: "stock", getValue: row => row.stock, defaultDirection: "desc" },
              { id: "price", label: "price", getValue: row => row.price, defaultDirection: "desc" },
              { id: "state", label: "state", getValue: row => row.tone },
            ]}
          >
            {(sortedRows, sort) => (
              <table className="trade-helper-market-table">
                <thead>
                  <tr>
                    <SortableTh sort={sort} columnId="good">Good</SortableTh>
                    <SortableTh sort={sort} columnId="stock" className="numeric">Stock</SortableTh>
                    <SortableTh sort={sort} columnId="price" className="numeric">Price</SortableTh>
                    <SortableTh sort={sort} columnId="state" className="numeric">State</SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map(row => (
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
          </SortableRows>
        )}
      </div>

      <div className="trade-helper-section">
        <div className="exchange-section-title">Nearby routes</div>
        {routeRows.length === 0 ? (
          <div className="trade-helper-line muted"><span>Routes</span><span>No direct lanes</span></div>
        ) : (
          <SortableRows
            rows={routeRows}
            columns={[
              { id: "station", label: "station", getValue: row => world.locations[row.to]?.name ?? row.to },
              { id: "dist", label: "distance", getValue: row => row.dist },
              { id: "jobs", label: "jobs", getValue: row => Object.values(world.jobs).filter(job => job.destination === row.to && job.acceptedBy == null).length, defaultDirection: "desc" },
            ]}
          >
            {(sortedRows, sort) => (
              <table className="trade-helper-market-table station-routes-table">
                <thead>
                  <tr>
                    <SortableTh sort={sort} columnId="station">Station</SortableTh>
                    <SortableTh sort={sort} columnId="dist" className="numeric">Dist</SortableTh>
                    <SortableTh sort={sort} columnId="jobs" className="numeric">Jobs</SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map(row => {
                    const jobs = Object.values(world.jobs).filter(job => job.destination === row.to && job.acceptedBy == null).length;
                    return (
                      <tr key={row.to}>
                        <td>
                          <span title={world.locations[row.to]?.name ?? row.to}>
                            {world.locations[row.to]?.name ?? row.to}
                          </span>
                        </td>
                        <td className="numeric mono">{row.dist.toFixed(1)}</td>
                        <td className="numeric mono">{jobs}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </SortableRows>
        )}
      </div>
    </InfoPanelFrame>
  );
}

function StationExchangeSection({ loc, world }: { loc: LocationDef; world: World }) {
  // Pull exchange data tied to this station: its listed share, the basis
  // equities for goods that move through it, and any futures contracts that
  // designate this station as the physical-delivery point.
  const stationEquity: Equity | null = Object.values(world.equities)
    .find(e => e.kind === "station" && e.underlyingId === loc.id) ?? null;

  const localBasis = Object.values(world.equities)
    .filter(e => {
      if (e.kind !== "basis") return false;
      const parsed = parseBasisUnderlying(e.underlyingId);
      return parsed?.locationId === loc.id;
    })
    .sort((a, b) => Math.abs(b.price - b.anchorPrice) - Math.abs(a.price - a.anchorPrice))
    .slice(0, 3);

  const localFutures = Object.values(world.contracts ?? {})
    .filter(c => c.deliveryStation === loc.id)
    .sort((a, b) => a.expiryTick - b.expiryTick);

  if (!stationEquity && localBasis.length === 0 && localFutures.length === 0) return null;

  // Glance preview only — last 100 samples is enough for the SVG line shape.
  // equity.history grows unbounded; mapping all of it on every render
  // dominates with thousands of ticks.
  const sparkPoints = (stationEquity?.history ?? []).slice(-100).map(h => h.price);
  const changePct = stationEquity ? priceChangePct(stationEquity) : 0;
  const changeTone = changePct > 0.0005 ? "good" : changePct < -0.0005 ? "bad" : "";
  const lastDiv = stationEquity?.lastDividend;
  const ticksSinceDiv = lastDiv ? Math.max(0, world.tick - lastDiv.tick) : null;

  return (
    <div className="trade-helper-section">
      <div className="exchange-section-title">Exchange</div>
      {stationEquity && (
        <>
          <div className="trade-helper-line station-exchange-quote">
            <span className="station-exchange-quote-left">
              <span className="station-exchange-ticker">{stationEquity.ticker}</span>
              <span className="mono station-exchange-price">Ç{stationEquity.price.toFixed(2)}</span>
            </span>
            <span className={`station-exchange-delta mono ${changeTone}`}>
              {changePct > 0 ? "+" : ""}{(changePct * 100).toFixed(2)}%
            </span>
          </div>
          {sparkPoints.length > 1 && (
            <MiniSparkline points={sparkPoints} className="station-exchange-spark" />
          )}
        </>
      )}
      {lastDiv && (
        <div className="trade-helper-line">
          <span>Last dividend</span>
          <span className="mono">Ç{lastDiv.perShare.toFixed(2)} / share · {ticksSinceDiv}t ago</span>
        </div>
      )}
      {localBasis.length > 0 && (
        <div className="trade-helper-line">
          <span>Basis spreads</span>
          <span className="station-basis-list">
            {localBasis.map(b => {
              const spread = b.price - b.anchorPrice;
              const tone = spread > 0.001 ? "good" : spread < -0.001 ? "bad" : "";
              return (
                <span key={b.id} className="station-basis-chip">
                  <span className="mono">{b.ticker}</span>
                  <span className={`mono ${tone}`}>{spread > 0 ? "+" : ""}Ç{spread.toFixed(2)}</span>
                </span>
              );
            })}
          </span>
        </div>
      )}
      {localFutures.length > 0 && (
        <div className="trade-helper-line">
          <span>Futures delivery</span>
          <span className="mono">
            {localFutures.length} contract{localFutures.length === 1 ? "" : "s"}
            {localFutures[0] && (
              <> · next {Math.max(0, localFutures[0].expiryTick - world.tick)}t</>
            )}
          </span>
        </div>
      )}
    </div>
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
  const shipTab = useStore((s) => s.fleetTab);
  const setShipTab = useStore((s) => s.setFleetTab);

  const debt = ship.maintenanceDebt ?? 0;
  const hullCost = hullRepairCost(ship);
  const totalRepairCost = debt + hullCost;
  const canRepair = totalRepairCost > 0 && ship.state === "idle";

  return (
    <section className="bridge-card ship-card">
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
        tab={shipTab}
        onTabChange={setShipTab}
      />
      <div className="ship-status-tabs bridge-card-tabs">
        <ShipFuelStatusEntry
          ship={ship}
          world={world}
          target={target}
          hintText={cueText.refuel ?? hintText}
          critical={critical}
          inTransit={inTransit}
        />
        <ShipPilotStatusEntry ship={ship} />
        <ShipMaintenanceStatusEntry
          ship={ship}
          debt={debt}
          hullCost={hullCost}
          totalCost={totalRepairCost}
          canRepair={canRepair}
          onRepair={() => repairShip(ship.id)}
        />
      </div>
      {SHOW_DEV_SHIP_PLAN_PANEL && <ShipPlanPanel ship={ship} world={world} guidedPlan={guidedPlan} hintText={hintText} />}
    </section>
  );
}

function meterTabStyle(pct: number): CSSProperties {
  return { "--meter-pct": `${Math.max(0, Math.min(100, pct))}%` } as CSSProperties;
}

function ShipFuelStatusEntry({ ship, world, target, hintText, critical, inTransit }: {
  ship: Trader;
  world: World;
  target: HintTarget;
  hintText: string;
  critical: boolean;
  inTransit: boolean;
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

function ShipMaintenanceStatusEntry({ ship, debt, hullCost, totalCost, canRepair, onRepair }: {
  ship: Trader;
  debt: number;
  hullCost: number;
  totalCost: number;
  canRepair: boolean;
  onRepair: () => void;
}) {
  const debtPct = (debt / MAINTENANCE_DEBT_TRAVEL_BLOCK) * 100;
  const baseHull = ship.baseHull ?? ship.hull ?? 1;
  const curHull = ship.hull ?? baseHull;
  const hullPct = baseHull > 0 ? ((baseHull - curHull) / baseHull) * 100 : 0;
  const damagePct = Math.max(0, Math.min(100, Math.max(debtPct, hullPct)));
  const conditionPct = Math.max(0, 100 - damagePct);
  // Grounded only by maintenance debt — hull damage degrades odds but
  // doesn't physically prevent travel in v1.
  const grounded = debt >= MAINTENANCE_DEBT_TRAVEL_BLOCK;
  const tone = grounded ? "bad" : conditionPct <= 30 ? "warn" : "";
  const attention = conditionPct <= 30;
  const hasCost = totalCost > 0.001;
  const percentText = `${Math.round(damagePct)}%`;
  const breakdown = (() => {
    const parts: string[] = [];
    if (debt > 0) parts.push(`maintenance Ç${Math.round(debt).toLocaleString()}`);
    if (hullCost > 0) parts.push(`hull Ç${Math.round(hullCost).toLocaleString()}`);
    return parts.join(" + ");
  })();
  const status = grounded
    ? `Grounded · ${breakdown || "repairs needed"}`
    : hasCost
      ? `Repairs Ç${Math.round(totalCost).toLocaleString()}${breakdown ? ` (${breakdown})` : ""}`
      : "Hull clear";
  const clickable = hasCost && canRepair;

  return (
    <ActionCell suggested={grounded} hintText="Repair hull damage before travel." critical>
      <button
        className={`bridge-tab ship-meter-tab ship-status-entry ship-maintenance-entry ${tone} ${attention ? "attention" : ""} ${grounded ? "has-suggestion btn-suggested-critical" : ""}`}
        style={meterTabStyle(damagePct)}
        onClick={onRepair}
        disabled={!clickable}
        title={`${status}${hasCost ? canRepair ? " · Repair ship" : " · Dock to repair" : ""}`}
      >
        <span className="ship-meter-label">Hull Damage</span>
        <span className="ship-meter-percent">{percentText}</span>
      </button>
    </ActionCell>
  );
}

function ShipPilotStatusEntry({ ship }: { ship: Trader }) {
  const setPilot = useStore((s) => s.setPilot);
  if (!hasCrew(ship, "captain")) return null;
  const auto = ship.pilot === "auto";
  const next = auto ? "manual" : "auto";
  const title = auto
    ? "Autopilot engaged — captain handles trading. Click for manual control."
    : "Manual control. Click to engage autopilot.";
  return (
    <button
      className={`bridge-tab ship-meter-tab ship-status-entry ship-pilot-entry ${auto ? "active" : ""}`}
      onClick={() => setPilot(ship.id, next)}
      title={title}
      type="button"
    >
      <span className="ship-meter-label">Autopilot</span>
      <span className="ship-meter-percent">{auto ? "ON" : "OFF"}</span>
    </button>
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
  return target.acceptJobId != null || (target.acceptJobIds?.length ?? 0) > 0;
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

function StationExchangeCard({ ship, world, loc, target, hintText, cueText, selectedGood, pinnedGoods, selectedBlueprintId, pinnedBlueprintIds, inTransit, onSelectGood, onHoverGood, onSelectBlueprint, onHoverBlueprint }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  target: HintTarget;
  hintText: string;
  cueText: CueTextMap;
  selectedGood: GoodId | null;
  pinnedGoods: Set<GoodId>;
  selectedBlueprintId: string | null;
  pinnedBlueprintIds: Set<string>;
  inTransit: boolean;
  onSelectGood: (good: GoodId) => void;
  onHoverGood: (good: GoodId | null) => void;
  onSelectBlueprint: (id: string) => void;
  onHoverBlueprint: (id: string | null) => void;
}) {
  // Both fleet-view cards bind to the shared FleetTab in the store —
  // selecting Markets/Offers/etc. on this side flips the ship card to
  // the matching tab on the other.
  const fleetTab = useStore((s) => s.fleetTab);
  const setFleetTab = useStore((s) => s.setFleetTab);
  const tab = fleetTabToExchangeTab(fleetTab);
  const setTab = (next: ExchangeTab) => setFleetTab(exchangeTabToFleetTab(next));
  const manualActions = ship.pilot !== "auto";
  const market = world.markets[loc.id];
  const offers = listHiresAt(world, loc.id);
  const localContractCount = listLocalJobs(world, loc.id).length;
  // Shipyards are a different kind of market: they sell ship blueprints
  // exclusively, no goods / upgrades / crew / contracts. The Markets tab
  // shows blueprints; the other tabs are hidden so the UI doesn't lie
  // about empty inventories.
  const isShipyard = loc.traits.tags.includes("shipyard");
  const blueprints = isShipyard ? listShipyardInventory(world, loc.id) : [];
  const marketGoodsCount = isShipyard
    ? blueprints.length
    : Object.keys(world.goods).filter(gid =>
        !isUpgradeGood(gid)
        && ((market.stock[gid] ?? 0) > 0.001 || findCargoLot(ship, gid) != null)
      ).length;
  const upgradeCount = Object.keys(world.goods).filter(gid => isUpgradeGood(gid) && (market.stock[gid] ?? 0) >= 1).length;
  const marketsSuggested = !isShipyard && manualActions && targetSuggestsMarketAction(target);
  const upgradesSuggested = !isShipyard && manualActions && targetSuggestsUpgradeBuy(target);
  const contractsSuggested = !isShipyard && manualActions && targetSuggestsContracts(target);
  const marketHintText = cueText.sections.market ?? hintText;
  const upgradeHintText = cueText.sections.upgrades ?? hintText;
  const contractHintText = cueText.sections.contracts ?? hintText;

  return (
    <section className={`bridge-card market-card exchange-card ${inTransit ? "transit-preview-card" : ""}`}>
      <div className="bridge-card-tabs">
        <button
          className={`bridge-tab ${tab === "markets" ? "active" : ""} ${marketsSuggested ? "has-suggestion" : ""}`}
          onClick={() => setTab("markets")}
          title={marketsSuggested ? marketHintText : undefined}
        >
          {isShipyard ? "Ships" : "Markets"} <span className="bridge-tab-count">{marketGoodsCount}</span>
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
          Contracts <span className="bridge-tab-count">{localContractCount}</span>
        </button>
      </div>
      <div className={`exchange-card-tab-body ${inTransit ? "transit-preview-content" : ""}`} data-scroll-key={`fleet:${ship.id}:exchange:${tab}`}>
        {tab === "markets" && (
          isShipyard ? (
            <ShipyardMarketBody
              ship={ship}
              world={world}
              loc={loc}
              blueprints={blueprints}
              interactionLocked={inTransit}
              selectedBlueprintId={selectedBlueprintId}
              pinnedBlueprintIds={pinnedBlueprintIds}
              onSelectBlueprint={onSelectBlueprint}
              onHoverBlueprint={onHoverBlueprint}
            />
          ) : (
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
          )
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
      <SortableRows
        rows={goodsOrdered}
        columns={[
          { id: "good", label: "good", getValue: gid => world.goods[gid].name },
          { id: "stock", label: "stock", getValue: gid => market.stock[gid] ?? 0, defaultDirection: "desc" },
          { id: "held", label: "held cargo", getValue: gid => findCargoLot(ship, gid)?.qty ?? 0, defaultDirection: "desc" },
          { id: "price", label: "price", getValue: gid => market.prices[gid] ?? 0, defaultDirection: "desc" },
          { id: "net-sell", label: "net sell", getValue: gid => (market.prices[gid] ?? 0) * (1 - 0.15), defaultDirection: "desc" },
        ]}
      >
        {(sortedGoods, sort) => (
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
                <SortableTh sort={sort} columnId="good">Good</SortableTh>
                <SortableTh sort={sort} columnId="stock" className="numeric">Stock</SortableTh>
                <SortableTh sort={sort} columnId="held" className="numeric">Held</SortableTh>
                <SortableTh sort={sort} columnId="price" className="numeric">Price</SortableTh>
                <SortableTh sort={sort} columnId="net-sell" className="numeric" title="Listed price minus 15% port tax. What you'd actually receive if you sold here.">Net Sell</SortableTh>
                {manualActions && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {sortedGoods.map((gid) => {
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
                    className={infoFocusRowClass(pinned)}
                    aria-selected={selectedGood === gid}
                    tabIndex={0}
                    onMouseEnter={() => onHoverGood(gid)}
                    onMouseLeave={() => onHoverGood(null)}
                    onFocus={(event) => {
                      if (!eventTargetsRowControl(event)) onHoverGood(gid);
                    }}
                    onBlur={(event) => {
                      const next = event.relatedTarget;
                      if (!(next instanceof Node) || !event.currentTarget.contains(next)) onHoverGood(null);
                    }}
                    onClick={(event) => {
                      if (!eventTargetsRowControl(event)) onSelectGood(gid);
                    }}
                    onKeyDown={(event) => handleInfoRowKeyDown(event, () => onSelectGood(gid))}
                  >
                    <td>
                      <span className="good-name-cell">
                        <span className="good-name">{world.goods[gid].name}</span>
                        <span className="good-name-sub dim">{world.goods[gid].category}</span>
                      </span>
                      {isFuel && <span className="row-meta-pill muted">fuel</span>}
                    </td>
                    <td className="numeric mono">{stock.toFixed(0)}</td>
                    <td className={`numeric mono market-held-cell ${isCargo ? "" : "dim"}`}>{isCargo ? cargoQty.toFixed(0) : "—"}</td>
                    <td className="numeric mono">Ç{price.toFixed(1)}</td>
                    <td className="numeric mono dim">Ç{netSell.toFixed(1)}</td>
                    {manualActions && (
                      <td data-row-action-cell>
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
        )}
      </SortableRows>
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
  const fuelCost = fuelType && !ignoresFuel(ship) ? dist * effectivePerDistance(ship, fuelType.perDistance) * fuelPrice : 0;
  const ticks = travelTicksFor(ship, dist);
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
  const renderedFocus = focus;
  const stationLoc = renderedFocus?.kind === "station" ? world.locations[renderedFocus.loc] ?? loc : loc;
  // Ship-art API hooks. When the ship view is the active focus, we
  // ask for a class-aware splash for the actively-controlled ship;
  // when a shipyard blueprint is the focus, we ask for one keyed on
  // the blueprint's class + traits + name so each ship-for-sale gets
  // its own image (same poolKey as the eventual minted ship, so the
  // cache hits on purchase). Both fall back to their static art URLs
  // until the API call lands so the panel never goes blank.
  const dynamicShipArt = useShipArtImageUrl(renderedFocus == null ? ship : null);
  const renderedBlueprint = renderedFocus?.kind === "ship-blueprint"
    ? findBlueprintEverywhere(world, renderedFocus.blueprintId)
    : null;
  const dynamicBlueprintArt = useBlueprintArtImageUrl(renderedBlueprint);
  const dynamicArtUrl = renderedFocus == null
    ? dynamicShipArt.imageUrl
    : renderedFocus.kind === "ship-blueprint"
      ? dynamicBlueprintArt.imageUrl
      : null;
  const infoArtUrl = renderedFocus == null
    ? dynamicArtUrl ?? shipArtUrl(ship)
    : renderedFocus.kind === "station"
      ? stationArtUrl(stationLoc)
      : renderedFocus.kind === "ship-blueprint"
        ? dynamicArtUrl ?? blueprintArtUrl(world, renderedFocus.blueprintId, ship)
        : goodArtUrl(world, renderedFocus.good);
  // The static art assets compose the ship in the upper third, but
  // the API-generated images center the subject. Override the
  // `--card-art-position` to `center center` when the painted url
  // came from the ship-art API so the ship is actually visible
  // inside the card's painter slot.
  const usingDynamicArt = dynamicArtUrl != null && infoArtUrl === dynamicArtUrl;

  return (
    <section
      className={`bridge-card trade-helper-card info-area-card ${infoArtUrl ? "art-card" : ""} ${renderedFocus == null || renderedFocus.kind === "station" ? "station-info-helper" : ""}`}
      style={infoArtUrl
        ? {
            ...artCardStyle(infoArtUrl),
            ...(usingDynamicArt ? { "--card-art-position": "center center" } as CSSProperties : {}),
          }
        : undefined}
    >
      <div
        className={`bridge-card-tabs info-area-tabs ${pinnedFocuses.length === 0 ? "empty" : ""}`}
        aria-label="Pinned info"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClearFocus();
        }}
      >
        {pinnedFocuses.length === 0 ? (
          <span className="info-area-tabs-empty">Hover to inspect · click to pin</span>
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
      <div className="info-area-content">
        <div key={requestedKey} className="info-area-values">
          <div className="info-area-detail">
            {renderedFocus == null ? (
              <ShipInfoPanelContent ship={ship} world={world} />
            ) : renderedFocus.kind === "station" ? (
              <StationTradeHelperInfoContent loc={stationLoc} world={world} />
            ) : renderedFocus.kind === "ship-blueprint" ? (
              <ShipBlueprintInfoContent ship={ship} world={world} blueprintId={renderedFocus.blueprintId} />
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
  const debt = ship.maintenanceDebt ?? 0;
  const debtPct = (debt / MAINTENANCE_DEBT_TRAVEL_BLOCK) * 100;
  const baseHull = ship.baseHull ?? ship.hull ?? 1;
  const curHull = ship.hull ?? baseHull;
  const hullPct = baseHull > 0 ? ((baseHull - curHull) / baseHull) * 100 : 0;
  const hullDamagePct = Math.max(0, Math.min(100, Math.max(debtPct, hullPct)));
  const hullCost = hullRepairCost(ship);
  const wage = totalCrewWage(ship);
  const positions = Object.values(ship.stockPositions ?? {});
  const recentActions = (ship.log ?? []).slice(-5).reverse();

  return (
    <InfoPanelFrame
      eyebrow="Ship info"
      title={ship.name}
      badge={(
        <div className="ship-info-quote">
          <span className="price big mono">Ç{Math.round(ship.funds).toLocaleString()}</span>
        </div>
      )}
    >
      {ship.state === "transit" && <TransitProgress ship={ship} world={world} />}

      <dl className="trade-helper-grid station-info-grid">
        <Stat label="cargo" value={`${cargoUsed.toFixed(0)} / ${ship.capacity}`} />
        <Stat label="fuel" value={`${fuelQty.toFixed(0)} / ${ship.fuelCapacity}`} />
        <Stat label="hull damage" value={`${Math.round(hullDamagePct)}%`} />
        <Stat label="hull" value={(ship.hull ?? ship.baseHull ?? 1).toLocaleString()} />
        <Stat label="speed" value={ship.speed.toLocaleString()} />
        <Stat label="weapons" value={(ship.weaponPower ?? ship.baseWeaponPower ?? 0).toLocaleString()} />
        <Stat label="upgrades" value={`${installedCount} / 5`} />
        <Stat label="crew" value={`${crewCount} / 3`} />
        <Stat label="service debt" value={`Ç${Math.round(debt + hullCost).toLocaleString()}`} />
        <Stat label="wages" value={`Ç${Math.round(wage).toLocaleString()}/t`} />
      </dl>

      <ShipActionsList entries={recentActions} />
      <ShipPositionsList positions={positions} world={world} />
    </InfoPanelFrame>
  );
}

function ShipPositionsList({ positions, world }: { positions: StockPosition[]; world: World }) {
  type Enriched = { pos: StockPosition; eq: typeof world.equities[string]; pnl: number; pnlPct: number };
  const enriched: Enriched[] = [];
  for (const pos of positions) {
    const eq = world.equities[pos.equityId];
    if (!eq) continue;
    const direction = pos.kind === "long" ? 1 : -1;
    const pnl = (eq.price - pos.avgEntryPrice) * pos.shares * direction;
    const basis = pos.avgEntryPrice * pos.shares;
    const pnlPct = basis > 0 ? (pnl / basis) * 100 : 0;
    enriched.push({ pos, eq, pnl, pnlPct });
  }
  enriched.sort((a, b) => b.pnlPct - a.pnlPct);
  const TOP_N = 10;
  const top = enriched.slice(0, TOP_N);
  const rest = enriched.slice(TOP_N);
  const restPnl = rest.reduce((s, e) => s + e.pnl, 0);
  const restTone = restPnl > 0 ? "good" : restPnl < 0 ? "bad" : "";

  return (
    <section className="ship-info-list-section">
      <div className="exchange-section-title">Positions</div>
      {enriched.length === 0 ? (
        <div className="ship-info-list-empty dim">No open positions.</div>
      ) : (
        <ul className="ship-info-mini-list">
          {top.map(({ pos, eq, pnl, pnlPct }) => {
            const tone = pnl > 0 ? "good" : pnl < 0 ? "bad" : "";
            return (
              <li key={pos.equityId} className="ship-info-mini-row">
                <span className={`ship-info-mini-side ${pos.kind}`}>{pos.kind === "long" ? "L" : "S"}</span>
                <span className="ship-info-mini-ticker mono">{eq.ticker}</span>
                <span className="ship-info-mini-meta dim mono">{pos.shares.toLocaleString()} sh @ Ç{pos.avgEntryPrice.toFixed(2)}</span>
                <span className={`ship-info-mini-value mono ${tone}`}>{pnl >= 0 ? "+" : ""}Ç{Math.round(pnl).toLocaleString()} ({pnlPct >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%)</span>
              </li>
            );
          })}
          {rest.length > 0 && (
            <li className="ship-info-mini-row ship-info-mini-summary">
              <span className="ship-info-mini-ticker dim">+{rest.length} more</span>
              <span className="ship-info-mini-meta dim mono">{rest.length === 1 ? "position" : "positions"}</span>
              <span className={`ship-info-mini-value mono ${restTone}`}>{restPnl >= 0 ? "+" : ""}Ç{Math.round(restPnl).toLocaleString()}</span>
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

function ShipActionsList({ entries }: { entries: ShipLogEntry[] }) {
  return (
    <section className="ship-info-list-section">
      <div className="exchange-section-title">Actions</div>
      {entries.length === 0 ? (
        <div className="ship-info-list-empty dim">No recorded actions yet.</div>
      ) : (
        <ul className="ship-info-mini-list">
          {entries.map((entry, i) => (
            <li key={`${entry.tick}-${i}`} className={`ship-info-mini-row ${entry.tone ?? ""}`}>
              <span className="ship-info-mini-tick mono dim">t{entry.tick.toLocaleString()}</span>
              <span className="ship-info-mini-kind dim">{entry.kind}</span>
              <span className="ship-info-mini-message">{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
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
          <SortableRows
            rows={lotRows}
            columns={[
              { id: "from", label: "source", getValue: lot => world.locations[lot.source]?.name ?? lot.source },
              { id: "qty", label: "quantity", getValue: lot => lot.qty, defaultDirection: "desc" },
              { id: "paid", label: "paid price", getValue: lot => lot.unitPrice, defaultDirection: "desc" },
              { id: "age", label: "age", getValue: lot => world.tick - lot.purchasedAt, defaultDirection: "desc" },
            ]}
          >
            {(sortedLots, sort) => (
              <table className="trade-helper-market-table trade-helper-lot-table">
                <thead>
                  <tr>
                    <SortableTh sort={sort} columnId="from">From</SortableTh>
                    <SortableTh sort={sort} columnId="qty" className="numeric">Qty</SortableTh>
                    <SortableTh sort={sort} columnId="paid" className="numeric">Paid</SortableTh>
                    <SortableTh sort={sort} columnId="age" className="numeric">Age</SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {sortedLots.map((lot, i) => (
                    <tr key={`${lot.source}-${lot.purchasedAt}-${i}`}>
                      <td title={world.locations[lot.source]?.name ?? lot.source}>{world.locations[lot.source]?.name ?? lot.source}</td>
                      <td className="numeric mono">{lot.qty.toFixed(0)}</td>
                      <td className="numeric mono">Ç{lot.unitPrice.toFixed(1)}</td>
                      <td className="numeric mono">{world.tick - lot.purchasedAt}t</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </SortableRows>
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
          <SortableRows
            rows={orderRows}
            columns={[
              { id: "station", label: "station", getValue: row => row.name },
              { id: "dist", label: "distance", getValue: row => row.dist },
              { id: "sell", label: "sell price", getValue: row => row.netSell, defaultDirection: "desc" },
              { id: "demand", label: "demand", getValue: row => row.demandGap, defaultDirection: "desc" },
              { id: "profit", label: "profit/loss", getValue: row => routeQty > 0 ? row.netAtQty : row.breakEvenQty ?? null, defaultDirection: "desc" },
            ]}
          >
            {(sortedRows, sort) => (
              <table className="trade-helper-market-table">
                <thead>
                  <tr>
                    <SortableTh sort={sort} columnId="station">Station</SortableTh>
                    <SortableTh sort={sort} columnId="dist" className="numeric">Dist</SortableTh>
                    <SortableTh sort={sort} columnId="sell" className="numeric">Sell</SortableTh>
                    <SortableTh sort={sort} columnId="demand" className="numeric">Demand</SortableTh>
                    <SortableTh sort={sort} columnId="profit" className="numeric">Profit/loss</SortableTh>
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map(row => {
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
          </SortableRows>
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

function ShipCargoTabs({ ship, world, loc, groups, inTransit, target, hintText, cueText, cargoUsed, cargoPct, selectedGood, pinnedGoods, onSelectGood, onHoverGood, tab, onTabChange }: {
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
  tab: ShipCargoTab;
  onTabChange: (tab: ShipCargoTab) => void;
}) {
  const installedCount = Object.keys(ship.upgrades ?? {}).length;
  const crewCount = Object.keys(ship.crew ?? {}).length;
  const activeContracts = Object.values(world.jobs).filter(j => j.acceptedBy === ship.id);
  const manualActions = ship.pilot !== "auto";
  const cargoSuggested = manualActions && targetSuggestsCargoAction(target);
  const contractsSuggested = manualActions && target.collectJobId != null && activeContracts.some(j => j.id === target.collectJobId);
  const cargoHintText = cueText.sections.cargo ?? hintText;
  const contractHintText = target.collectJobId ? cueText.collectJobs[target.collectJobId] ?? hintText : hintText;

  return (
    <div className="ship-cargo-section">
      <div className="bridge-card-tabs ship-cargo-tabs">
        <button
          className={`bridge-tab ship-meter-tab cargo-meter-tab ${tab === "cargo" ? "active" : ""} ${cargoSuggested ? "has-suggestion" : ""}`}
          style={meterTabStyle(cargoPct)}
          onClick={() => onTabChange("cargo")}
          title={cargoSuggested ? cargoHintText : `${cargoPct.toFixed(0)}% cargo capacity used`}
        >
          Cargo
          <span className="bridge-tab-count">{cargoUsed.toFixed(0)}/{ship.capacity}</span>
        </button>
        <button
          className={`bridge-tab ${tab === "upgrades" ? "active" : ""}`}
          onClick={() => onTabChange("upgrades")}
        >
          Upgrades <span className="bridge-tab-count">{installedCount}/5</span>
        </button>
        <button
          className={`bridge-tab ${tab === "crew" ? "active" : ""}`}
          onClick={() => onTabChange("crew")}
        >
          Crew <span className="bridge-tab-count">{crewCount}/3</span>
        </button>
        <button
          className={`bridge-tab ${tab === "contracts" ? "active" : ""} ${contractsSuggested ? "has-suggestion" : ""}`}
          onClick={() => onTabChange("contracts")}
          title={contractsSuggested ? contractHintText : undefined}
        >
          Contracts <span className="bridge-tab-count">{activeContracts.length}</span>
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
      {tab === "contracts" && <ActiveContractsTab ship={ship} world={world} jobs={activeContracts} target={target} cueText={cueText} hintText={hintText} />}
    </div>
  );
}

const UPGRADE_SLOT_RANK: Record<UpgradeSlot, number> = {
  cargo: 0,
  engine: 1,
  fuel: 2,
  hull: 3,
  weapon: 4,
  systems: 5,
};

const UPGRADE_SLOT_ICONS: Record<UpgradeSlot, IconType> = {
  cargo: GiCargoCrate,
  engine: GiSpeedometer,
  fuel: GiFuelTank,
  hull: GiAutoRepair,
  weapon: GiCrossedSwords,
  systems: GiProcessor,
};

function compareUpgradeGoods(a: string, b: string): number {
  const da = upgradeDef(a);
  const db = upgradeDef(b);
  if (!da || !db) return a.localeCompare(b);
  // Slot first so variants of the same slot cluster — the rest of the
  // UI groups by slot too. Tier ascending within a slot so basic
  // options lead and exotics trail.
  return UPGRADE_SLOT_RANK[da.slot] - UPGRADE_SLOT_RANK[db.slot]
    || da.tier - db.tier
    || da.name.localeCompare(db.name);
}

function upgradeSlotLabel(slot: UpgradeSlot): string {
  return UPGRADE_SLOTS.find(s => s.slot === slot)?.label ?? slot;
}

// Rarity class for upgrade tiers — drives the title color, tier badge,
// and card border accent. Mirrors the four-step Diablo-style scale:
// common (white) → uncommon (blue) → rare (purple) → legendary (gold).
function upgradeRarityClass(tier: number): "common" | "uncommon" | "rare" | "legendary" {
  if (tier >= 4) return "legendary";
  if (tier === 3) return "rare";
  if (tier === 2) return "uncommon";
  return "common";
}

function UpgradeEffectPills({ text }: { text: string }) {
  return (
    <div className="upgrade-effect-pills">
      {text.split(" · ").filter(Boolean).map((part) => (
        <span key={part} className="upgrade-effect-pill">{part}</span>
      ))}
    </div>
  );
}

function unloadingRemainingPct(ship: Trader, good: GoodId): number {
  const maxTicksLeft = unloadTicksRemainingFor(ship, good);
  return Math.max(0, Math.min(100, (maxTicksLeft / UNLOAD_TICKS) * 100));
}

function ShipUpgradesTab({ ship }: { ship: Trader }) {
  const installFromCargo = useStore((s) => s.installUpgradeFromCargo);
  const removeInstalledUpgrade = useStore((s) => s.removeInstalledUpgrade);
  const sell = useStore((s) => s.sell);
  const docked = ship.state === "idle";
  const cargoUpgrades = groupCargoByGood(ship)
    .filter(g => isUpgradeGood(g.good))
    .sort((a, b) => compareUpgradeGoods(a.good, b.good));

  return (
    <div className="upgrades-tab">
      <div className="upgrade-slot-grid">
        {UPGRADE_SLOTS.map(({ slot, label }) => {
          const def = installedUpgrade(ship, slot);
          const Icon = UPGRADE_SLOT_ICONS[slot];
          const rarity = def ? upgradeRarityClass(def.tier) : "common";
          return (
            <article key={slot} className={`upgrade-card upgrade-slot-card ${def ? "installed" : "empty"} rarity-${rarity}`}>
              <Icon className="upgrade-card-splash" aria-hidden="true" focusable="false" />
              <div className="upgrade-card-main">
                <div className="upgrade-card-top">
                  <span className={`upgrade-slot-copy slot-${slot}`}>{label}</span>
                  {def ? (
                    <button
                      type="button"
                      className={`tier-badge upgrade-remove-pill rarity-${rarity}`}
                      onClick={() => removeInstalledUpgrade(ship.id, slot)}
                      disabled={!docked}
                      title={docked ? `Remove ${def.name} to cargo` : "Dock to remove"}
                      aria-label={`Remove ${def.name}`}
                    >
                      <span className="upgrade-remove-tier">T{def.tier}</span>
                      <span className="upgrade-remove-copy">Remove</span>
                    </button>
                  ) : (
                    <span className="upgrade-source-pill">Empty</span>
                  )}
                </div>
                {def ? (
                  <>
                    <div className="upgrade-card-heading">
                      <div className="upgrade-card-name">{def.name}</div>
                      {def.description && <div className="upgrade-card-description">{def.description}</div>}
                    </div>
                    <div className="upgrade-card-bottom">
                      <UpgradeEffectPills text={upgradeEffectText(def)} />
                    </div>
                  </>
                ) : (
                  <div className="upgrade-card-bottom">
                    <span className="upgrade-empty-bottom">No module installed</span>
                  </div>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <div className="upgrade-offer-title dim">Cargo modules</div>
      {cargoUpgrades.length === 0 ? (
        <div className="upgrade-empty-card">No upgrade modules in cargo.</div>
      ) : (
        <div className="upgrade-offer-grid">
          {cargoUpgrades.map((group) => {
            const def = upgradeDef(group.good)!;
            const Icon = UPGRADE_SLOT_ICONS[def.slot];
            const installedInSlot = ship.upgrades?.[def.slot];
            const alreadyInstalled = installedInSlot === def.id;
            const replaceMode = installedInSlot != null && !alreadyInstalled;
            const replacedDef = replaceMode ? upgradeDef(installedInSlot) : null;
            const isUnloading = group.unloadingQty > 0;
            const remainingPct = isUnloading ? unloadingRemainingPct(ship, group.good) : 0;
            const installDisabled = !docked || alreadyInstalled || group.totalQty < 1 || isUnloading;
            const sellDisabled = !docked || group.totalQty < 1 || isUnloading;
            const title = !docked
              ? "Dock to install"
              : alreadyInstalled
                ? "Already installed"
                  : isUnloading
                    ? "Wait for unloading to finish"
                    : group.totalQty < 1
                      ? "No cargo module ready"
                      : replaceMode
                        ? `Replace ${replacedDef?.name ?? "installed module"} with ${def.name}`
                        : `Install ${def.name} from cargo`;
            const installLabel = alreadyInstalled ? "Installed" : replaceMode ? "Replace" : "Install";
            const sellTitle = !docked
              ? "Dock to sell"
              : isUnloading
                ? `Unloading ${group.unloadingQty.toFixed(0)} ${def.name}`
                : group.totalQty < 1
                  ? "No cargo module ready"
                  : `Sell ${def.name}`;
            return (
              <article key={`cargo-${group.good}`} className={`upgrade-card upgrade-offer-card rarity-${upgradeRarityClass(def.tier)}`}>
                <Icon className="upgrade-card-splash" aria-hidden="true" focusable="false" />
                <div className="upgrade-card-main">
                  <div className="upgrade-card-top">
                    <span className={`upgrade-slot-copy slot-${def.slot}`}>{upgradeSlotLabel(def.slot)}</span>
                    {replaceMode && replacedDef && (
                      <span className="upgrade-replace-hint dim">replaces {replacedDef.name}</span>
                    )}
                  </div>
                  <div className="upgrade-card-heading">
                    <div className="upgrade-card-name">{def.name}</div>
                    {def.description && <div className="upgrade-card-description">{def.description}</div>}
                  </div>
                  <div className="upgrade-card-bottom">
                    <UpgradeEffectPills text={upgradeEffectText(def)} />
                  </div>
                </div>
                <div className="upgrade-card-actions">
                  <span className={`tier-badge upgrade-action-tier rarity-${upgradeRarityClass(def.tier)}`}>T{def.tier}</span>
                  <div className="upgrade-action-stack">
                    <span className="upgrade-action-meta mono">
                      {isUnloading ? `Unloading x${group.unloadingQty.toFixed(0)}` : `Cargo x${group.totalQty.toFixed(0)}`}
                    </span>
                    {isUnloading ? (
                      <button
                        className="btn-action upgrade-action upgrade-sell-action primary cargo-sell-progress"
                        disabled
                        title={`Unloading ${group.unloadingQty.toFixed(0)} ${def.name} — ${Math.round(100 - remainingPct)}% delivered`}
                        style={{ ["--remaining" as string]: `${remainingPct}%` }}
                      >
                        <span className="btn-label">Unloading</span>
                        <span className="btn-count">{group.unloadingQty.toFixed(0)}</span>
                      </button>
                    ) : (
                      <>
                        <button
                          className="btn-action upgrade-action primary"
                          onClick={() => installFromCargo(ship.id, def.id)}
                          disabled={installDisabled}
                          title={title}
                        >
                          <span className="btn-label">{installLabel}</span>
                        </button>
                        <button
                          className="btn-action upgrade-action upgrade-sell-action"
                          onClick={() => sell(ship.id, def.id, 1)}
                          disabled={sellDisabled}
                          title={sellTitle}
                        >
                          <span className="btn-label">Sell</span>
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Shipyards swap the goods Markets table for a ship-blueprint table.
// Hovering a row sets the active info focus to that blueprint so the
// info panel switches to the dedicated ship-info content. Clicking the
// row pins it (exact same toggle-pin behaviour as goods rows).
function ShipyardMarketBody({ ship, loc, blueprints, interactionLocked, selectedBlueprintId, pinnedBlueprintIds, onSelectBlueprint, onHoverBlueprint }: {
  ship: Trader;
  world: World;
  loc: LocationDef;
  blueprints: ShipBlueprint[];
  interactionLocked: boolean;
  selectedBlueprintId: string | null;
  pinnedBlueprintIds: Set<string>;
  onSelectBlueprint: (id: string) => void;
  onHoverBlueprint: (id: string | null) => void;
}) {
  const [buyTargetId, setBuyTargetId] = useState<string | null>(null);
  // The buying ship is the one this fleet card already represents — by
  // construction it must be docked here for the card to render at all.
  const canBuy = !interactionLocked && ship.state === "idle" && ship.location === loc.id;
  if (blueprints.length === 0) {
    return (
      <div className="market-table-zone">
        <table className="market-table market-table-readonly">
          <thead>
            <tr>
              <th>Ship</th>
              <th>Class</th>
              <th className="numeric">Price</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colSpan={3} className="dim" style={{ padding: "20px 12px", textAlign: "center" }}>No blueprints in inventory right now. Check back soon.</td></tr>
          </tbody>
        </table>
      </div>
    );
  }
  return (
    <div
      className="market-table-zone"
      onMouseLeave={() => onHoverBlueprint(null)}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) onHoverBlueprint(null);
      }}
    >
      <SortableRows
        rows={blueprints}
        columns={[
          { id: "name",  label: "ship",  getValue: bp => bp.name },
          { id: "class", label: "class", getValue: bp => bp.classLabel },
          { id: "cargo", label: "cargo", getValue: bp => bp.baseCapacity, defaultDirection: "desc" },
          { id: "speed", label: "speed", getValue: bp => bp.baseSpeed, defaultDirection: "desc" },
          { id: "hull",  label: "hull",  getValue: bp => bp.baseHull, defaultDirection: "desc" },
          { id: "price", label: "price", getValue: bp => bp.price, defaultDirection: "desc" },
        ]}
      >
        {(sorted, sort) => (
          <table className={`market-table shipyard-market-table ${!canBuy ? "market-table-readonly" : ""}`}>
            <colgroup>
              <col className="col-good" />
              <col className="col-num" />
              <col className="col-num" />
              <col className="col-num" />
              <col className="col-num" />
              <col className="col-num" />
              {canBuy && <col className="col-action" />}
            </colgroup>
            <thead>
              <tr>
                <SortableTh sort={sort} columnId="name">Ship</SortableTh>
                <SortableTh sort={sort} columnId="class">Class</SortableTh>
                <SortableTh sort={sort} columnId="cargo" className="numeric">Cargo</SortableTh>
                <SortableTh sort={sort} columnId="speed" className="numeric">Speed</SortableTh>
                <SortableTh sort={sort} columnId="hull"  className="numeric">Hull</SortableTh>
                <SortableTh sort={sort} columnId="price" className="numeric">Price</SortableTh>
                {canBuy && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {sorted.map(bp => {
                const affordable = ship.funds >= bp.price;
                const blockedReason = !affordable
                  ? `Need Ç${bp.price.toLocaleString()}, have Ç${Math.floor(ship.funds).toLocaleString()}.`
                  : "";
                const pinned = pinnedBlueprintIds.has(bp.id);
                return (
                  <tr
                    key={bp.id}
                    className={infoFocusRowClass(pinned, "shipyard-market-row")}
                    aria-selected={selectedBlueprintId === bp.id}
                    tabIndex={0}
                    onMouseEnter={() => onHoverBlueprint(bp.id)}
                    onMouseLeave={() => onHoverBlueprint(null)}
                    onFocus={(event) => {
                      if (!eventTargetsRowControl(event)) onHoverBlueprint(bp.id);
                    }}
                    onBlur={(event) => {
                      const next = event.relatedTarget;
                      if (!(next instanceof Node) || !event.currentTarget.contains(next)) onHoverBlueprint(null);
                    }}
                    onClick={(event) => {
                      if (!eventTargetsRowControl(event)) onSelectBlueprint(bp.id);
                    }}
                    onKeyDown={(event) => handleInfoRowKeyDown(event, () => onSelectBlueprint(bp.id))}
                  >
                    <td>
                      <span className="shipyard-row-name">{bp.name}</span>
                      {bp.traits.length > 0 && (
                        <span className="shipyard-row-trait dim"> · {bp.traits.length} trait{bp.traits.length === 1 ? "" : "s"}</span>
                      )}
                    </td>
                    <td>
                      <span className={`shipyard-class-pill shipyard-class-${bp.class}`}>{bp.classLabel}</span>
                    </td>
                    <td className="numeric mono">{bp.baseCapacity}</td>
                    <td className="numeric mono">{bp.baseSpeed.toFixed(2)}</td>
                    <td className="numeric mono">{bp.baseHull}</td>
                    <td className="numeric mono">{fmtPrice(bp.price)}</td>
                    {canBuy && (
                      <td data-row-action-cell>
                        <button
                          type="button"
                          className="btn-action btn-buy-ship"
                          disabled={!affordable}
                          title={blockedReason}
                          onClick={(event) => {
                            event.stopPropagation();
                            if (!affordable) return;
                            setBuyTargetId(bp.id);
                          }}
                        >
                          Buy
                        </button>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </SortableRows>
      <BuyShipModal
        open={buyTargetId !== null}
        blueprint={buyTargetId ? blueprints.find(bp => bp.id === buyTargetId) ?? null : null}
        buyer={ship}
        onClose={() => setBuyTargetId(null)}
      />
    </div>
  );
}

function fmtPrice(amount: number): string {
  if (amount >= 1_000_000) return `Ç${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `Ç${(amount / 1_000).toFixed(0)}k`;
  return `Ç${amount.toLocaleString()}`;
}

// Art for a ship-blueprint info card. We don't have per-class hero
// renders yet, so use the buying ship's art as a stand-in — keeps the
// art slot warm and gives the panel some visual weight.
function blueprintArtUrl(world: World, blueprintId: string, fallbackShip: Trader): string {
  void world;
  void blueprintId;
  return shipArtUrl(fallbackShip);
}

// Info-panel content for a focused ship blueprint. Clones the structure
// of ShipInfoPanelContent so it slots into the existing info-card frame
// — eyebrow / title / meta line, KPI grid, themed sections — but with
// blueprint-shaped data plus a Buy CTA.
function ShipBlueprintInfoContent({ ship, world, blueprintId }: { ship: Trader; world: World; blueprintId: string }) {
  const [buyOpen, setBuyOpen] = useState(false);
  const found = findBlueprintEverywhere(world, blueprintId);
  if (!found) {
    return (
      <InfoPanelFrame
        eyebrow="Ship blueprint"
        title="Sold or expired"
        metaClassName="station-info-tags"
        meta={<span className="dim">This blueprint is no longer in inventory.</span>}
      >
        <div className="dim" style={{ padding: 12 }}>Pick another row to inspect.</div>
      </InfoPanelFrame>
    );
  }
  const bp = found;
  const station = world.locations[bp.locationId];
  const dockedHere = ship.state === "idle" && ship.location === bp.locationId;
  const affordable = ship.funds >= bp.price;
  const buyDisabledReason = !dockedHere
    ? `Dock ${ship.name} at ${station?.name ?? "this shipyard"} to take delivery.`
    : !affordable
      ? `Need Ç${bp.price.toLocaleString()}, ${ship.name} has Ç${Math.floor(ship.funds).toLocaleString()}.`
      : "";

  return (
    <InfoPanelFrame
      eyebrow="Ship blueprint"
      title={bp.name}
      badge={<span className={`station-kind-pill shipyard-class-${bp.class}`}>{bp.classLabel}</span>}
      metaClassName="station-info-tags"
      meta={(
        <>
          <span>{station?.name ?? bp.locationId}</span>
          <span>{world.goods[bp.fuelType]?.name ?? bp.fuelType}</span>
          <span>{Object.keys(bp.preInstalled).length} pre-installed</span>
          {bp.traits.length > 0 && <span>{bp.traits.length} trait{bp.traits.length === 1 ? "" : "s"}</span>}
        </>
      )}
    >
      <div className="trade-helper-note shipyard-info-flavor">{bp.flavor}</div>

      <dl className="trade-helper-grid station-info-grid">
        <Stat label="price" value={fmtPrice(bp.price)} />
        <Stat label="cargo" value={`${bp.baseCapacity}`} />
        <Stat label="speed" value={bp.baseSpeed.toFixed(2)} />
        <Stat label="fuel cap" value={`${bp.baseFuelCapacity}`} />
        <Stat label="hull" value={`${bp.baseHull}`} />
        <Stat label="weapons" value={`${bp.baseWeaponPower}`} />
      </dl>

      <div className="trade-helper-section">
        <div className="exchange-section-title">Pre-installed upgrades</div>
        {Object.keys(bp.preInstalled).length === 0 ? (
          <div className="trade-helper-line muted"><span>None</span><span className="dim">bare hull</span></div>
        ) : (
          (Object.keys(bp.preInstalled) as UpgradeSlot[]).map(slot => {
            const goodId = bp.preInstalled[slot];
            const def = goodId ? upgradeDef(goodId) : null;
            if (!def) return null;
            return (
              <div key={slot} className="trade-helper-line">
                <span><IconLabel icon={GiFactory}>{def.name}</IconLabel></span>
                <span className="dim mono">{slotLabel(slot)} · T{def.tier}</span>
              </div>
            );
          })
        )}
      </div>

      <div className="trade-helper-section">
        <div className="exchange-section-title">Traits</div>
        {bp.traits.length === 0 ? (
          <div className="trade-helper-line muted"><span>Standard hull</span><span className="dim">no special perks</span></div>
        ) : (
          bp.traits.map(trait => (
            <div key={trait} className="trade-helper-line">
              <span><IconLabel icon={traitIconFor(trait)}>{shipTraitLabel(trait)}</IconLabel></span>
              <span className="dim shipyard-trait-blurb">{shipTraitBlurb(trait)}</span>
            </div>
          ))
        )}
      </div>

      <div className="trade-helper-section shipyard-buy-section">
        <button
          type="button"
          className="btn-action btn-buy-ship-large primary"
          disabled={!dockedHere || !affordable}
          title={buyDisabledReason}
          onClick={() => {
            if (!dockedHere || !affordable) return;
            setBuyOpen(true);
          }}
        >
          Buy for Ç{bp.price.toLocaleString()}
        </button>
        {buyDisabledReason && <div className="dim shipyard-buy-blocked">{buyDisabledReason}</div>}
      </div>
      <BuyShipModal
        open={buyOpen}
        blueprint={bp}
        buyer={ship}
        onClose={() => setBuyOpen(false)}
      />
    </InfoPanelFrame>
  );
}

function slotLabel(slot: UpgradeSlot): string {
  return UPGRADE_SLOTS.find(s => s.slot === slot)?.label ?? slot;
}

function shipTraitLabel(trait: ShipTrait): string {
  switch (trait) {
    case "self-piloted":   return "Self-piloted";
    case "ai-navigator":   return "AI navigator";
    case "extra-slot":     return "+1 upgrade slot";
    case "fuel-efficient": return "Fuel-efficient";
    case "rapid-unload":   return "Rapid unload";
  }
}

function shipTraitBlurb(trait: ShipTrait): string {
  switch (trait) {
    case "self-piloted":   return "no captain crew needed";
    case "ai-navigator":   return "autopilot without a navigator";
    case "extra-slot":     return "one bonus upgrade socket";
    case "fuel-efficient": return "burns less per distance";
    case "rapid-unload":   return "faster unload at every dock";
  }
}

function traitIconFor(trait: ShipTrait): IconType {
  switch (trait) {
    case "self-piloted":   return GiAstronautHelmet;
    case "ai-navigator":   return GiPathDistance;
    case "extra-slot":     return GiFactory;
    case "fuel-efficient": return GiFuelTank;
    case "rapid-unload":   return GiCargoCrate;
  }
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
    <div className="upgrade-purchase-panel">
      {stationUpgradeIds.length === 0 ? (
        <div className="upgrade-empty-card">No upgrade modules stocked at this station.</div>
      ) : (
        <div className="upgrade-offer-grid station-upgrade-grid">
          {stationUpgradeIds.map((goodId) => {
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
              <article key={goodId} className={`upgrade-card upgrade-offer-card rarity-${upgradeRarityClass(def.tier)} ${suggested ? "suggested" : ""}`}>
                <Icon className="upgrade-card-splash" aria-hidden="true" focusable="false" />
                <div className="upgrade-card-main">
                  <div className="upgrade-card-top">
                    <span className={`upgrade-slot-copy slot-${def.slot}`}>{upgradeSlotLabel(def.slot)}</span>
                  </div>
                  <div className="upgrade-card-heading">
                    <div className="upgrade-card-name">{def.name}</div>
                    {def.description && <div className="upgrade-card-description">{def.description}</div>}
                  </div>
                  <div className="upgrade-card-bottom">
                    <UpgradeEffectPills text={upgradeEffectText(def)} />
                  </div>
                </div>
                <div className="upgrade-card-actions">
                  <span className={`tier-badge upgrade-action-tier rarity-${upgradeRarityClass(def.tier)}`}>T{def.tier}</span>
                  <div className="upgrade-action-stack">
                    <span className="upgrade-action-meta mono">Stock {stock.toFixed(0)}</span>
                    <span className="upgrade-action-price mono">Ç{Math.round(price).toLocaleString()}</span>
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
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
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
    <div className="cargo-table-zone" data-scroll-key={`fleet:${ship.id}:cargo`}>
      <SortableRows
        rows={groups}
        columns={[
          { id: "good", label: "good", getValue: group => world.goods[group.good]?.name ?? group.good },
          { id: "qty", label: "quantity", getValue: group => group.totalQty + group.unloadingQty, defaultDirection: "desc" },
          {
            id: "pnl",
            label: "profit/loss",
            getValue: group => group.totalQty * marketQuote(world, loc.id, group.good) * (1 - SALES_TAX_RATE) - group.totalCost,
            defaultDirection: "desc",
          },
        ]}
      >
        {(sortedGroups, sort) => (
          <table className="cargo-table">
            <colgroup>
              <col />
              <col className="col-num" />
              <col className="cargo-col-pnl" />
              {manualActions && <col className="cargo-col-action" />}
            </colgroup>
            <thead>
              <tr>
                <SortableTh sort={sort} columnId="good">Good</SortableTh>
                <SortableTh sort={sort} columnId="qty" className="numeric">Qty</SortableTh>
                <SortableTh sort={sort} columnId="pnl" className="numeric">P&amp;L <span className="dim">({inTransit ? "on arrival" : "here"})</span></SortableTh>
                {manualActions && <th>Action</th>}
              </tr>
            </thead>
            <tbody>
              {sortedGroups.length === 0 ? (
                <tr><td colSpan={manualActions ? 4 : 3} className="cargo-row-empty">Cargo bay empty</td></tr>
              ) : (
                sortedGroups.map((g) => (
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
        )}
      </SortableRows>
    </div>
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
  const totalOnShip = group.totalQty + group.unloadingQty;
  const isUnloading = group.unloadingQty > 0;
  const canSell = ship.state === "idle" && group.totalQty > 0 && !isUnloading;
  // Drip progress: max ticks remaining across this good's unloading lots /
  // UNLOAD_TICKS. With per-lot timers, a follow-up Sell click on the same good
  // bumps the bar back up (newest lot starts at full) but earlier lots
  // continue draining on their own schedule underneath.
  const remainingPct = isUnloading ? unloadingRemainingPct(ship, group.good) : 0;

  return (
    <tr
      className={infoFocusRowClass(pinned, "cargo-row")}
      aria-selected={selected}
      tabIndex={0}
      onMouseEnter={() => onHover(group.good)}
      onMouseLeave={() => onHover(null)}
      onFocus={(event) => {
        if (!eventTargetsRowControl(event)) onHover(group.good);
      }}
      onBlur={(event) => {
        const next = event.relatedTarget;
        if (!(next instanceof Node) || !event.currentTarget.contains(next)) onHover(null);
      }}
      onClick={(event) => {
        if (!eventTargetsRowControl(event)) onSelect();
      }}
      onKeyDown={(event) => handleInfoRowKeyDown(event, onSelect)}
    >
      <td>
        <span className="good-name-cell">
          <span className="cargo-row-name">{good.name}</span>
          <span className="good-name-sub dim">{good.category}</span>
        </span>
        {group.lots.length > 1 && <span className="row-meta-pill cargo-row-lots">{group.lots.length} lots</span>}
      </td>
      <td className="numeric mono">{totalOnShip.toFixed(0)}</td>
      <td className={`numeric mono cargo-row-pnl ${pnlTone}`}>
        {pnl >= 0 ? "+" : ""}Ç{Math.round(pnl).toLocaleString()}
        <span className="dim"> ({pnl >= 0 ? "+" : ""}{pnlPct.toFixed(0)}%)</span>
      </td>
      {showAction && (
        <td data-row-action-cell>
          <ActionCell suggested={suggested} hintText={hintText}>
            {isUnloading ? (
              <button
                className="btn-action cargo-sell-action primary cargo-sell-progress"
                disabled
                title={`Unloading ${group.unloadingQty.toFixed(0)} ${good.name} — ${Math.round(100 - remainingPct)}% delivered`}
                style={{ ["--remaining" as string]: `${remainingPct}%` }}
              >
                <span className="btn-label">Unloading</span>
                <span className="btn-count">{group.unloadingQty.toFixed(0)}</span>
              </button>
            ) : (
              <button
                className={`btn-action cargo-sell-action ${suggested ? "btn-suggested" : "primary"}`}
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
            )}
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
  unloadSpeedBonus:    (v) => `+${(v * 100).toFixed(0)}% unload`,
  instantUnload:        () => "instant unload",
  remoteSettlementCollection: () => "remote exchange",
  instantTravel:        () => "FTL jump",
  fuelFreeTravel:       () => "zero fuel travel",
  buyDiscount:         (v) => `−${(v * 100).toFixed(0)}% buy`,
  sellPremium:         (v) => `+${(v * 100).toFixed(0)}% sell`,
  maintenanceDiscount: (v) => `−${(v * 100).toFixed(0)}% maint`,
  contractRewardBonus: (v) => `+${(v * 100).toFixed(0)}% contracts`,
  dockingDiscount:     (v) => `−${(v * 100).toFixed(0)}% docking`,
  fuelRegenIdle:       (v) => `+${v.toFixed(1)} fuel/tick`,
  treasuryYield:       (v) => `+${(v * 100).toFixed(2)}%/tick yield`,
  dividendBonus:       (v) => `+${(v * 100).toFixed(0)}% dividends`,
};

function modifiersText(mods: CrewModifiers): string {
  const entries = Object.entries(mods).filter(([, v]) => v) as [keyof CrewModifiers, number][];
  return entries.map(([k, v]) => MOD_LABEL[k](v)).join(" · ");
}

function ModifierPills({ mods }: { mods: CrewModifiers }) {
  const entries = Object.entries(mods).filter(([, v]) => v) as [keyof CrewModifiers, number][];
  if (entries.length === 0) return <span className="faint">No specialty modifiers</span>;
  return (
    <div className="crew-mod-pill-row">
      {entries.map(([key, value]) => (
        <span key={key} className="crew-mod-pill">{MOD_LABEL[key](value)}</span>
      ))}
    </div>
  );
}

// Crew tab inside the Cargo card — current crew only. Each role row shows
// who's hired (or vacant) with a Fire button. Hiring happens from the
// "Hire offers" tab next to the market.
function CrewTab({ ship }: { ship: Trader }) {
  const docked = ship.state === "idle";
  const roles: { role: CrewRole; label: string }[] = [
    { role: "captain",   label: "Pilot" },
    { role: "navigator", label: "Navigator" },
    { role: "mechanic",  label: "Mechanic" },
    { role: "mercenary", label: "Mercenary" },
  ];

  return (
    <div className="crew-card-grid">
      {roles.map(({ role, label }) => {
        const member = ship.crew?.[role];
        return (
          <CrewRoleCard
            key={role}
            shipId={ship.id}
            role={role}
            label={label}
            member={member}
            docked={docked}
          />
        );
      })}
    </div>
  );
}

function CrewRoleCard({
  shipId, role, label, member, docked,
}: {
  shipId: string;
  role: CrewRole;
  label: string;
  member: CrewMember | undefined;
  docked: boolean;
}) {
  const fire = useStore((s) => s.fireCrew);
  const activeSaveId = useStore((s) => s.activeSaveId);
  const headshot = useCrewHeadshot(activeSaveId, member);
  const showImage = !!member && headshot?.status === "ready";
  const cardStyle: CSSProperties | undefined = showImage && headshot.status === "ready"
    ? { backgroundImage: `url(${headshot.url})` }
    : undefined;
  const headshotStateClass = !member
    ? ""
    : headshot?.status === "ready"
      ? "has-headshot"
      : headshot?.status === "loading"
        ? "headshot-loading"
        : "";
  return (
    <article
      className={`crew-card ${member ? "filled" : "empty"} ${headshotStateClass}`.trim()}
      style={cardStyle}
    >
      <div className="crew-card-main">
        <div className="crew-card-head">
          <span className="crew-role-label">{label}</span>
          {!member && <span className="upgrade-source-pill">Vacant</span>}
        </div>
        <div className="crew-card-name">{member?.name ?? "Open crew station"}</div>
        <div className="crew-card-bottom">
          {member ? <ModifierPills mods={member.modifiers} /> : <span className="crew-empty-bottom">Vacant berth</span>}
        </div>
      </div>
      {member && (
        <div className="crew-card-actions">
          <span className={`tier-badge crew-action-tier tier-${tierClass(member.tier)}`}>T{member.tier}</span>
          <div className="crew-action-stack">
            <span className="crew-action-price mono">Ç{member.wagePerTick}/t</span>
            <button
              className="btn-action crew-card-action"
              onClick={() => fire(shipId, role)}
              disabled={!docked}
              title={docked ? "Stop wages. No refund." : "Dock to fire"}
            >
              <span className="btn-label">Fire</span>
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

// Accepted-contract list for this ship. Per-ship view lets the player see
// at-a-glance what their currently-focused ship is committed to.
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
        <SortableRows
          rows={sorted}
          columns={[
            { id: "tier", label: "tier", getValue: j => TIER_RANK[j.tier] },
            { id: "contract", label: "contract", getValue: j => j.kind === "trade" ? `${j.trade?.ticker ?? "Trade"} settlement` : j.good ? world.goods[j.good]?.name ?? j.good : j.kind },
            { id: "progress", label: "progress", getValue: j => j.kind === "trade" ? Number(j.destination === ship.location) : j.qty > 0 ? j.delivered / j.qty : 0, defaultDirection: "desc" },
            { id: "reward", label: "reward", getValue: j => j.reward, defaultDirection: "desc" },
            { id: "penalty", label: "penalty", getValue: j => j.penalty, defaultDirection: "desc" },
            { id: "expires", label: "expiry", getValue: j => Math.max(0, j.expiresAt - world.tick) },
          ]}
        >
          {(sortedJobs, sort) => (
            <table className="jobs-table contract-table active-contracts-table">
              <colgroup>
                <col className="col-tier" />
                <col />
                <col className="col-progress" />
                <col className="col-money" />
                <col className="col-money" />
                <col className="col-expires" />
                <col className="col-action" />
              </colgroup>
              <thead>
                <tr>
                  <SortableTh sort={sort} columnId="tier">Tier</SortableTh>
                  <SortableTh sort={sort} columnId="contract">Contract</SortableTh>
                  <SortableTh sort={sort} columnId="progress">Progress</SortableTh>
                  <SortableTh sort={sort} columnId="reward" className="numeric">Reward</SortableTh>
                  <SortableTh sort={sort} columnId="penalty" className="numeric">Penalty</SortableTh>
                  <SortableTh sort={sort} columnId="expires" className="numeric">Expires</SortableTh>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortedJobs.map((j) => {
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
        </SortableRows>
      )}
    </>
  );
}

// "Hire offers" sits next to Market in the bottom split — same tabbed pattern
// as Cargo|Crew above. Lists posted offers at the docked station with their
// expiry countdown; rows are sorted tier asc / cost asc by listHiresAt.
function HireOffersTab({ ship, world, loc, interactionLocked }: { ship: Trader; world: World; loc: LocationDef; interactionLocked: boolean }) {
  const offers = listHiresAt(world, loc.id);
  const docked = ship.state === "idle" && ship.location === loc.id && !interactionLocked;

  return (
    <div className="crew-offer-panel">
      {offers.length === 0 ? (
        <div className="upgrade-empty-card">No crew posted at {loc.name}.</div>
      ) : (
        <div className="crew-offer-grid">
          {offers.map((h) => (
            <HireOfferCard
              key={h.id}
              hire={h}
              shipId={ship.id}
              shipFunds={ship.funds}
              worldTick={world.tick}
              docked={docked}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function HireOfferCard({
  hire: h, shipId, shipFunds, worldTick, docked,
}: {
  hire: import("../../sim/types").Hire;
  shipId: TraderId;
  shipFunds: number;
  worldTick: number;
  docked: boolean;
}) {
  const hire = useStore((s) => s.hireCrew);
  const activeSaveId = useStore((s) => s.activeSaveId);
  const headshot = useCrewHeadshot(activeSaveId, h);
  const ticksLeft = Math.max(0, h.expiresAt - worldTick);
  const mods = modifiersText(h.modifiers);
  const canAfford = shipFunds >= h.hireCost;
  const showImage = headshot?.status === "ready";
  const cardStyle: CSSProperties | undefined = showImage && headshot.status === "ready"
    ? { backgroundImage: `url(${headshot.url})` }
    : undefined;
  const headshotStateClass = headshot?.status === "ready"
    ? "has-headshot"
    : headshot?.status === "loading"
      ? "headshot-loading"
      : "";
  return (
    <article
      className={`crew-card crew-offer-card tier-${tierClass(h.tier)} ${headshotStateClass}`.trim()}
      style={cardStyle}
    >
      <div className="crew-card-main">
        <div className="crew-card-head">
          <span className="crew-role-label">{ROLE_SHORT[h.role]}</span>
        </div>
        <div className="crew-card-name">{h.name}</div>
        <div className="crew-card-bottom" title={mods || undefined}>
          <ModifierPills mods={h.modifiers} />
        </div>
      </div>
      <div className="crew-card-actions">
        <span className={`tier-badge crew-action-tier tier-${tierClass(h.tier)}`}>T{h.tier}</span>
        <div className="crew-action-stack">
          <span className="crew-action-price mono" title={`Wage Ç${h.wagePerTick}/t · expires in ${ticksLeft}t`}>Ç{h.hireCost.toLocaleString()}</span>
          <button
            className={`btn-action crew-card-action ${canAfford && docked ? "primary" : ""}`}
            onClick={() => hire(shipId, h.id)}
            disabled={!canAfford || !docked}
            title={!docked ? "Dock to hire" : !canAfford ? `Need Ç${h.hireCost.toLocaleString()}` : "Sign on (replaces any existing in this role)"}
          >
            <span className="btn-label">Hire</span>
          </button>
        </div>
      </div>
    </article>
  );
}

const ROLE_SHORT: Record<CrewRole, string> = {
  captain: "Pilot", navigator: "Navigator", mechanic: "Mechanic", mercenary: "Mercenary",
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
  const fuelFree = ignoresFuel(ship);
  const ft = ship.fuelTypes.find(f => f.good === ship.currentFuel?.good) ?? ship.fuelTypes[0];
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

  const neighborDests = reachableNeighbors(world, routeFrom)
    .map(({ to, dist }) => {
      const dst = world.locations[to];
      const fuelNeeded = ft && !fuelFree ? dist * effectivePerDistance(ship, ft.perDistance) : 0;
      const fuelCost = ft && !fuelFree ? fuelNeeded * (market.prices[ft.good] ?? 0) : 0;
      const travelTicks = travelTicksFor(ship, dist);
      const canFly = fuelFree || (ft != null && fuel >= fuelNeeded);
      return { to, name: dst?.name ?? to, dist, fuelNeeded, fuelCost, travelTicks, canFly };
    })
    .sort((a, b) => a.dist - b.dist);
  const currentLocation = world.locations[routeFrom];
  const currentStationName = currentLocation?.name ?? world.locations[routeFrom]?.name ?? loc.name;
  const currentStationJobs = activeJobsByDestination.get(routeFrom) ?? [];
  const currentPinned = pinnedStations.has(routeFrom);
  const travelSuggested = !inTransit && manualActions && neighborDests.some(d => target.travelTo === d.to && d.canFly);
  const travelHintText = target.travelTo ? cueText.travel[target.travelTo] ?? cueText.sections.travel ?? hintText : hintText;
  // Right-side slot: while in transit, manual ships get a "Quick
  // Travel" button (ticks live in its bridge-tab-count); auto ships
  // get a passive ticks-remaining badge in the same slot. Idle ships
  // get nothing.
  const transitTab = inTransit ? (
    manualActions ? (
      <button
        className="travel-panel-action"
        onClick={() => stepN(ship.ticksRemaining)}
        title={`Advance ${ship.ticksRemaining} ticks until arrival`}
      >
        Quick Travel <span className="bridge-tab-count">{ship.ticksRemaining}t</span>
      </button>
    ) : (
      <span className="travel-panel-ticks" title={`${ship.ticksRemaining} ticks until arrival`}>
        <span className="bridge-tab-count">{ship.ticksRemaining}t</span>
      </span>
    )
  ) : null;
  const travelTitle = inTransit ? "Route dest" : "Current location";
  // Meta only carries useful info while docked — in transit, the
  // neighbor list is from the destination and the player hasn't arrived
  // yet, so showing "N reachable stations" reads as stale. Drop the
  // fallback in transit; if there's a contract at the destination we
  // still surface that line.
  const currentMeta = currentStationJobs.length > 0
    ? contractLine(currentStationJobs)
    : inTransit
      ? null
      : `${neighborDests.length} reachable station${neighborDests.length === 1 ? "" : "s"}`;

  return (
    <section className="bridge-card travel-card">
      <header
        className={`travel-panel-head art-panel-head ${travelSuggested ? "has-suggestion" : ""}`}
        style={currentLocation ? artCardStyle(stationArtUrl(currentLocation)) : undefined}
        title={travelSuggested ? travelHintText : undefined}
      >
        <div className="travel-panel-main">
          <div className="travel-panel-kicker">
            <span className="travel-panel-label">{travelTitle}</span>
          </div>
          {currentMeta && <span className="travel-current-meta">{currentMeta}</span>}
          <button
            type="button"
            className={`travel-current-station info-focus-trigger ${currentPinned ? "is-pinned" : ""}`}
            aria-pressed={currentPinned}
            onMouseEnter={() => onHoverStation(routeFrom)}
            onMouseLeave={() => onHoverStation(null)}
            onFocus={() => onHoverStation(routeFrom)}
            onBlur={() => onHoverStation(null)}
            onClick={() => onSelectStation(routeFrom)}
          >
            <span className="travel-current-name">{currentStationName}</span>
          </button>
        </div>
        {transitTab}
      </header>
      <div className="travel-table-zone" data-scroll-key={`fleet:${ship.id}:travel`}>
        <SortableRows
          rows={neighborDests}
          columns={[
            { id: "to", label: "destination", getValue: d => d.name },
            { id: "dist", label: "distance", getValue: d => d.dist },
            { id: "fuel", label: "fuel", getValue: d => d.fuelNeeded },
            { id: "time", label: "travel time", getValue: d => d.travelTicks },
          ]}
        >
          {(sortedDests, sort) => (
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
                  <SortableTh sort={sort} columnId="to">To</SortableTh>
                  <SortableTh sort={sort} columnId="dist" className="numeric">Dist</SortableTh>
                  <SortableTh sort={sort} columnId="fuel" className="numeric">Fuel</SortableTh>
                  <SortableTh sort={sort} columnId="time" className="numeric">Time</SortableTh>
                  {manualActions && <th></th>}
                </tr>
              </thead>
              <tbody>
                {sortedDests.map((d) => {
                  const suggested = target.travelTo === d.to;
                  const destinationJobs = activeJobsByDestination.get(d.to) ?? [];
                  const travelLabel = suggested ? target.travelLabel : undefined;
                  const pinned = pinnedStations.has(d.to);
                  const isPoi = travelLabel != null;
                  const departGuarded = !inTransit && d.canFly && shouldGuardDepartureForSuggestions(world, target, d.to, ship);
                  const departArmed = armedDepart === d.to;
                  return (
                    <tr
                      key={d.to}
                      className={infoFocusRowClass(pinned, `${isPoi ? "travel-is-poi" : ""} ${destinationJobs.length > 0 ? "travel-has-contract" : ""}`)}
                      aria-selected={selectedStation === d.to}
                      tabIndex={0}
                      onMouseEnter={() => onHoverStation(d.to)}
                      onMouseLeave={() => onHoverStation(null)}
                      onFocus={(event) => {
                        if (!eventTargetsRowControl(event)) onHoverStation(d.to);
                      }}
                      onBlur={(event) => {
                        const next = event.relatedTarget;
                        if (!(next instanceof Node) || !event.currentTarget.contains(next)) onHoverStation(null);
                      }}
                      onClick={(event) => {
                        if (!eventTargetsRowControl(event)) onSelectStation(d.to);
                      }}
                      onKeyDown={(event) => handleInfoRowKeyDown(event, () => onSelectStation(d.to))}
                    >
                      <td>
                        <div className="travel-dest-cell">
                          <span className={`travel-dest-title ${isPoi ? "travel-dest-title-poi" : ""}`}>
                            <span className="travel-dest-name">{d.name}</span>
                          </span>
                          {(travelLabel || destinationJobs.length > 0) && (
                            <span className="travel-contract-line">
                              {travelLabel && <span className="travel-poi-label">{travelLabel}</span>}
                              {destinationJobs.length > 0 && <span>{contractLine(destinationJobs)}</span>}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="numeric mono">{d.dist.toFixed(1)}</td>
                      <td className={`numeric mono ${!d.canFly ? "bad" : ""}`}>{d.fuelNeeded.toFixed(1)}</td>
                      <td className="numeric mono">{d.travelTicks}t</td>
                      {manualActions && (
                        <td data-row-action-cell>
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
          )}
        </SortableRows>
      </div>
    </section>
  );
}
