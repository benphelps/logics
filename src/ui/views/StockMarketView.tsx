import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MdArrowDropDown, MdArrowDropUp, MdRemove } from "react-icons/md";
import {
  AreaSeries,
  ColorType,
  HistogramSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useStore } from "../store";
import { getTradeRecordsBefore } from "../historyDb";
import type { BookTrade, Equity, EquityKind, FuturesContract, FuturesPosition, Order, OrderBook, StockPosition, TradeRecord, World } from "../../sim/types";
import { hasCrew } from "../../sim/crew";
import { canDeliverPhysical, listPlayerFutures, unrealizedFuturesPnl } from "../../sim/stock/futures";
import {
  BROKER_FEE_RATE,
  DIVIDEND_INTERVAL,
  EXCHANGE_TRADE_MAX_HOPS,
  basisSpreadVsSpot,
  equityTradeHopDistance,
  equityTradeStation,
  listEquities,
  listSectorIndices,
  listPlayerLimits,
  listPositions,
  listTradeRecords,
  maxShortableShares,
  parseBasisUnderlying,
  priceChangePct,
  stationNetTradeMultiplier,
  totalUnrealizedPnl,
  unrealizedPnl,
  type PlayerLimitView,
} from "../../sim/stock";
import { listStockExchangeHints, type StockExchangeHint } from "../../sim/stock/suggestions";
import { goodArtUrl, shipArtUrl, stationArtUrl, stationKind, stationKindLabel, stationScale, stationScaleLabel, stationSubtype, stationSubtypeLabel } from "../art";
import { SortableHeaderButton, SortableRows, SortableTh } from "../components/SortableTable";
import "./StockMarketView.css";

// Resolve which player ship is currently the trading agent. The TopBar
// ship-picker writes `selectedTrader` into the store; if it points at one
// of the player's ships, that's our pick — otherwise we fall back to the
// first ship in the fleet so an unset picker still works (single-ship
// players, fresh worlds, etc.).
function useSelectedPlayerShipId(world: World): string | undefined {
  const selected = useStore(s => s.selectedTrader);
  if (!world.player) return undefined;
  const ids = world.player.shipIds;
  if (selected && ids.includes(selected)) return selected;
  return ids[0];
}

interface EquityRow {
  equity: Equity;
  kindLabel: string;
  changePct: number;
  ratioToAnchor: number;
  position: StockPosition | null;
  futuresPosition: FuturesPosition | null;
  hasPosition: boolean;
  unrealized: number;
  lastDividendPerShare: number;
  ticksUntilDividend: number;
  underlyingHealth: number;
  underlyingHealthLabel: string;
}

const KIND_LABEL: Record<EquityKind, string> = {
  station: "Station",
  syndicate: "Syndicate",
  commodity: "Commodity",
  basis: "Basis",
  futures: "Futures",
  index: "Index",
};

export function StockMarketView() {
  const world = useStore((s) => s.world);
  const selected = useStore((s) => s.selectedEquity);
  const select = useStore((s) => s.selectEquity);
  const sellShares = useStore((s) => s.sellShares);
  const coverShares = useStore((s) => s.coverShares);
  const abandonPosition = useStore((s) => s.abandonPosition);
  const setStopLoss = useStore((s) => s.setStopLoss);
  const setTakeProfit = useStore((s) => s.setTakeProfit);
  const lastError = useStore((s) => s.lastError);
  const clearError = useStore((s) => s.clearError);
  const selectedTrader = useStore((s) => s.selectedTrader);
  const tickEpoch = useStore((s) => s.tickEpoch);

  // When a position row is clicked, focus on it: the Positions panel
  // collapses to only that entry and surfaces close-side controls inline.
  // Clicking the same focused row toggles back to the full list. When the
  // position is closed (manual sell, cover, abandon, or auto-trigger), the
  // useEffect below clears the focus so we naturally fall back to the list.
  const [focusedPositionId, setFocusedPositionId] = useState<string | null>(null);
  const [activePanel, setActivePanel] = useState<"tape" | "positions" | "trades">("tape");

  const rows = useMemo(() => buildRows(world), [world, tickEpoch]);
  const playerShipIds = world.player?.shipIds ?? [];
  const playerShip = selectedTrader && playerShipIds.includes(selectedTrader)
    ? world.traders[selectedTrader] ?? playerShipIds.map(id => world.traders[id]).find(Boolean) ?? null
    : playerShipIds.map(id => world.traders[id]).find(Boolean) ?? null;
  const playerShipId = playerShip?.id;
  const stockGuidanceUnlocked = playerShip ? hasCrew(playerShip, "navigator") : false;
  const tapeRows = useMemo(() => splitRowsByAccess(world, rows, playerShipId), [world, rows, playerShipId]);
  const selectedId = selected && rows.some(r => r.equity.id === selected)
    ? selected
    : tapeRows.reachable[0]?.equity.id ?? rows[0]?.equity.id ?? null;
  const detail = selectedId ? rows.find(r => r.equity.id === selectedId) ?? null : null;
  const exchangeHints = useMemo(
    () => stockGuidanceUnlocked ? listStockExchangeHints(world, playerShipId, rows.length) : [],
    [world, playerShipId, rows, tickEpoch, stockGuidanceUnlocked],
  );
  const hintByEquity = useMemo(() => {
    const map = new Map<string, StockExchangeHint>();
    for (const hint of exchangeHints) map.set(hint.equityId, hint);
    return map;
  }, [exchangeHints]);
  const selectedHint = detail ? hintByEquity.get(detail.equity.id) ?? null : null;
  const stockGuideEnabled = useStore((s) => s.stockGuideEnabled);
  const setStockGuideEnabled = useStore((s) => s.setStockGuideEnabled);
  const guidedTradeEnabled = stockGuidanceUnlocked && stockGuideEnabled;
  const topTradeHint = exchangeHints.find(h => h.action !== "watch" && h.executable) ?? null;
  const activeTradeHint = guidedTradeEnabled ? topTradeHint : null;
  const activeSelectedHint = activeTradeHint && detail?.equity.id === activeTradeHint.equityId
    ? activeTradeHint
    : null;

  const docked = !!playerShip && playerShip.state === "idle";
  const cash = playerShip?.funds ?? 0;
  const unrealizedTotal = totalUnrealizedPnl(world);
  const positions = useMemo(() => listPositions(world), [world, tickEpoch]);
  // Use the in-memory ledger directly (capped at ~200 by historyDb's
  // post-flush trim). Older entries live in IDB and TradesList lazy-loads
  // them when the user scrolls past the in-memory window.
  const trades = useMemo(() => listTradeRecords(world), [world, tickEpoch]);
  const longCount = positions.filter(p => p.kind === "long").length;
  const shortCount = positions.filter(p => p.kind === "short").length;

  // Stable callback ref so PnoPanel's React.memo can skip re-renders when
  // selectedEquity flips. The inline arrow function would create a new ref
  // each render and defeat memoization.
  const handleAbandon = useCallback((eqId: string) => {
    const pos = positions.find(p => p.equityId === eqId);
    const shares = pos?.shares ?? 0;
    const ticker = world.equities[eqId]?.ticker ?? eqId;
    if (confirm(`Abandon ${shares} shares of ${ticker}? Settles at the current mark with a 5% penalty.`)) {
      abandonPosition(eqId);
    }
  }, [positions, world.equities, abandonPosition]);
  const detailArtUrl = detail ? equityArtUrl(world, detail.equity) : null;

  // If the focused position closed (sold / covered / abandoned / auto-fired
  // stop or take), drop focus so the Positions panel falls back to the full
  // list instead of showing an empty focused state.
  useEffect(() => {
    if (focusedPositionId && !positions.some(p => p.equityId === focusedPositionId)) {
      setFocusedPositionId(null);
    }
  }, [focusedPositionId, positions]);

  useEffect(() => {
    if (!stockGuidanceUnlocked && stockGuideEnabled) {
      setStockGuideEnabled(false);
    }
  }, [stockGuidanceUnlocked, stockGuideEnabled, setStockGuideEnabled]);

  void activePanel; void setActivePanel; void focusedPositionId; void setFocusedPositionId;
  void detailArtUrl; void unrealizedTotal; void longCount; void shortCount;

  return (
    <section className="stocks-view">
      {lastError && (
        <div className="stocks-error" onClick={clearError}>
          {lastError} <span className="stocks-error-dismiss">dismiss</span>
        </div>
      )}

      <div className="stocks-shell">
        <aside className="stocks-shell-left">
          <EquitySelector
            rows={rows}
            tapeRows={tapeRows}
            selectedId={selectedId}
            activeHint={activeTradeHint}
            bestHint={topTradeHint}
            guideEnabled={guidedTradeEnabled}
            emptyText={stockGuidanceUnlocked ? "No actionable exchange trade right now." : "Hire a navigator for exchange insights."}
            onGuideToggle={() => stockGuidanceUnlocked && setStockGuideEnabled(!stockGuideEnabled)}
            onSelect={select}
          />
          <PnoPanel
            world={world}
            positions={positions}
            trades={trades}
            hints={exchangeHints}
            insightsEmptyText={stockGuidanceUnlocked ? "No trade insights right now." : "Hire a navigator for exchange insights."}
            shipId={playerShipId}
            cash={cash}
            docked={docked}
            activeHint={activeTradeHint}
            onSelectEquity={select}
            onSell={sellShares}
            onCover={coverShares}
            onAbandon={handleAbandon}
            onSetStopLoss={setStopLoss}
            onSetTakeProfit={setTakeProfit}
          />
        </aside>

        <aside className="stocks-shell-right">
          {detail ? (
            <InfoColumn
              row={detail}
              world={world}
              shipId={playerShipId}
              docked={docked}
              hint={activeSelectedHint}
              selectedHint={selectedHint}
              activeHint={activeTradeHint}
              guideEnabled={guidedTradeEnabled}
              emptyText={stockGuidanceUnlocked ? "No listing insights" : "Hire a navigator for listing insights."}
            />
          ) : (
            <div className="stocks-detail-empty dim">No listed equities.</div>
          )}
        </aside>
      </div>
    </section>
  );
}

// --- new shell components ----------------------------------------------

const STOCK_GUIDE_TOOLTIP_WIDTH = 280;
const STOCK_GUIDE_TOOLTIP_MARGIN = 12;
const STOCK_GUIDE_TOOLTIP_GAP = 10;

function StockGuidanceMarker({ tip, label = "Guided trade", onClick }: {
  tip: string;
  label?: string;
  onClick?: () => void;
}) {
  const dotRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const show = () => {
    const el = dotRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let left = rect.left;
    if (left + STOCK_GUIDE_TOOLTIP_WIDTH > window.innerWidth - STOCK_GUIDE_TOOLTIP_MARGIN) {
      left = window.innerWidth - STOCK_GUIDE_TOOLTIP_MARGIN - STOCK_GUIDE_TOOLTIP_WIDTH;
    }
    if (left < STOCK_GUIDE_TOOLTIP_MARGIN) left = STOCK_GUIDE_TOOLTIP_MARGIN;
    setPos({ left, top: rect.top - STOCK_GUIDE_TOOLTIP_GAP });
  };
  const hide = () => setPos(null);
  const activate = () => {
    if (!onClick) return;
    onClick();
    hide();
  };

  return (
    <span
      className={`stock-guidance-marker ${onClick ? "clickable" : ""}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={(event) => {
        if (!onClick) return;
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
      onKeyDown={(event) => {
        if (!onClick) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        activate();
      }}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : -1}
    >
      <span className="stock-guidance-marker-dot" ref={dotRef} />
      {pos && createPortal(
        <span
          className="stock-guidance-tooltip"
          role="tooltip"
          style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
        >
          <span className="stock-guidance-tooltip-label">{label}</span>
          {tip}
        </span>,
        document.body,
      )}
    </span>
  );
}

function StockGuidanceCell({ guided, hintText, label, onPingClick, className = "", style, children }: {
  guided: boolean;
  hintText: string;
  label?: string;
  onPingClick?: () => void;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <span className={`stock-guidance-cell ${className}`} style={style}>
      {guided && <StockGuidanceMarker tip={hintText} label={label} onClick={onPingClick} />}
      {children}
    </span>
  );
}

function isShareOrderHint(hint: StockExchangeHint | null): hint is StockExchangeHint & { action: "buy" | "sell" | "short" } {
  return hint?.action === "buy" || hint?.action === "sell" || hint?.action === "short";
}

function isOpenFuturesHint(hint: StockExchangeHint | null): hint is StockExchangeHint & { action: "open_long_future" | "open_short_future" } {
  return hint?.action === "open_long_future" || hint?.action === "open_short_future";
}

import type { StockKindFilter as KindFilter } from "../viewTabs";
const KIND_FILTERS: KindFilter[] = ["all", "positions", "station", "syndicate", "commodity", "basis", "futures", "index"];
const KIND_FILTER_LABEL: Record<KindFilter, string> = {
  all: "All",
  positions: "Positions",
  station: "Stations",
  syndicate: "Syndicates",
  commodity: "Commodities",
  basis: "Basis",
  futures: "Futures",
  index: "Indices",
};

function EquitySelector({ rows, tapeRows, selectedId, activeHint, bestHint, guideEnabled, emptyText, onGuideToggle, onSelect }: {
  rows: EquityRow[];
  tapeRows: { reachable: EquityRow[]; far: EquityRow[] };
  selectedId: string | null;
  activeHint: StockExchangeHint | null;
  bestHint: StockExchangeHint | null;
  guideEnabled: boolean;
  emptyText: string;
  onGuideToggle: () => void;
  onSelect: (eqId: string) => void;
}) {
  const kindFilter = useStore((s) => s.stockKindFilter);
  const setKindFilter = useStore((s) => s.setStockKindFilter);
  const filterRow = (r: EquityRow) => kindFilter === "all"
    || (kindFilter === "positions" ? r.hasPosition : r.equity.kind === kindFilter);
  const reachable = tapeRows.reachable.filter(filterRow);
  const far = tapeRows.far.filter(filterRow);
  const sortableRows = [...reachable, ...far];
  // Counts for the tab bar — same kindFilter applied to the unfiltered total.
  const counts: Record<KindFilter, number> = { all: 0, positions: 0, station: 0, syndicate: 0, commodity: 0, basis: 0, futures: 0, index: 0 };
  for (const r of [...tapeRows.reachable, ...tapeRows.far]) {
    counts.all++;
    if (r.hasPosition) counts.positions++;
    counts[r.equity.kind]++;
  }
  const activeHintRow = activeHint ? rows.find(r => r.equity.id === activeHint.equityId) ?? null : null;
  const tabHasActiveHint = (kf: KindFilter) => !!activeHint && (
    kf === "positions" ? !!activeHintRow?.hasPosition : kf !== "all" && activeHint.equityKind === kf
  );
  return (
    <SortableRows
      rows={sortableRows}
      columns={[
        { id: "ticker", label: "ticker", getValue: row => row.equity.ticker },
        { id: "listing", label: "listing", getValue: row => row.equity.name },
        { id: "price", label: "price", getValue: row => row.equity.price, defaultDirection: "desc" },
        { id: "change", label: "change", getValue: row => row.changePct, defaultDirection: "desc" },
      ]}
    >
      {(sortedRows, sort) => {
        const reachableIds = new Set(reachable.map(r => r.equity.id));
        const sortedReachable = sortedRows.filter(r => reachableIds.has(r.equity.id));
        const sortedFar = sortedRows.filter(r => !reachableIds.has(r.equity.id));
        return (
          <section className="stocks-shell-panel stocks-selector">
            <div className="bridge-card-tabs stocks-pno-tabs">
              {KIND_FILTERS.map(kf => (kf === "positions" || counts[kf] > 0) && (
                <button
                  key={kf}
                  type="button"
                  className={`bridge-tab ${kindFilter === kf ? "active" : ""} ${tabHasActiveHint(kf) ? "has-suggestion" : ""}`}
                  onClick={() => setKindFilter(kf)}
                  title={activeHint && tabHasActiveHint(kf) ? `Show ${activeHint.ticker}` : undefined}
                >
                  {KIND_FILTER_LABEL[kf]} <span className="bridge-tab-count">{counts[kf]}</span>
                </button>
              ))}
            </div>
            <div className="stocks-selector-header">
              <SortableHeaderButton sort={sort} columnId="ticker">Ticker</SortableHeaderButton>
              <SortableHeaderButton sort={sort} columnId="listing">Listing</SortableHeaderButton>
              <SortableHeaderButton sort={sort} columnId="price" className="numeric">Price</SortableHeaderButton>
              <SortableHeaderButton sort={sort} columnId="change" className="numeric">Δ</SortableHeaderButton>
            </div>
            <div className="stocks-selector-list" data-scroll-key={`exchange:selector:${kindFilter}`}>
              {sortedRows.length === 0 && (
                <div className="stocks-detail-empty dim">
                  {kindFilter === "positions" ? "No open listing positions." : "No listings in this tab."}
                </div>
              )}
              {sortedReachable.map(r => (
                <SelectorRow
                  key={r.equity.id}
                  row={r}
                  selected={r.equity.id === selectedId}
                  activeHint={activeHint}
                  onSelect={onSelect}
                />
              ))}
              {sortedFar.length > 0 && (
                <>
                  <div className="stocks-selector-divider">Out of range</div>
                  {sortedFar.map(r => (
                    <SelectorRow
                      key={r.equity.id}
                      row={r}
                      selected={r.equity.id === selectedId}
                      activeHint={activeHint}
                      onSelect={onSelect}
                      farRow
                    />
                  ))}
                </>
              )}
            </div>
            <StockHintChin
              hint={bestHint}
              guided={activeHint != null && bestHint != null && activeHint.equityId === bestHint.equityId && activeHint.action === bestHint.action}
              guideEnabled={guideEnabled}
              marqueeOverflow
              onGuideToggle={onGuideToggle}
              emptyText={emptyText}
            />
          </section>
        );
      }}
    </SortableRows>
  );
}

// Memoized — there are 100+ rows in the selector and each parent re-render
// (every selectedId change) used to re-render every row. With memo, only the
// previously-selected row and the newly-selected row re-render; the other
// 100+ skip. That's the bulk of the equity-switch click cost in dev mode.
const SelectorRow = memo(function SelectorRow({ row, selected, activeHint, onSelect, farRow = false }: {
  row: EquityRow;
  selected: boolean;
  activeHint: StockExchangeHint | null;
  onSelect: (eqId: string) => void;
  farRow?: boolean;
}) {
  const eq = row.equity;
  const tone = row.changePct > 0.0005 ? "up" : row.changePct < -0.0005 ? "down" : "flat";
  const ownedTone = row.position?.kind === "long" ? "owned" : row.position?.kind === "short" ? "shorted" : "";
  const isGuidedTicker = activeHint?.equityId === eq.id;
  return (
    <button
      type="button"
      className={`stocks-selector-row ${selected ? "selected" : ""} ${tone} ${ownedTone} ${farRow ? "far" : ""}`}
      onClick={() => onSelect(eq.id)}
    >
      <StockGuidanceCell
        guided={isGuidedTicker}
        hintText={activeHint ? `Open ${activeHint.ticker} to ${activeHint.actionLabel.toLowerCase()}.` : ""}
      >
        <span className="ticker mono">{eq.ticker}</span>
      </StockGuidanceCell>
      <span className="stocks-selector-name">
        <span className="name">{eq.name}</span>
        <span className="kind dim">{KIND_LABEL[eq.kind].toLowerCase()}</span>
      </span>
      <span className="stocks-selector-price mono">Ç{fmtPrice(eq.price)}</span>
      <span className={`stocks-selector-delta mono ${tone}`}>{fmtPct(row.changePct)}</span>
    </button>
  );
});

// --- positions, orders, history (P&O) panel ----------------------------

// Memoized — props are stable (positions/trades come from cached useMemos,
// callbacks are now stable refs from the parent), so equity-switch clicks
// (which only flip selectedEquity) skip the entire PnoPanel subtree.
const PnoPanel = memo(function PnoPanel(props: {
  world: World;
  positions: StockPosition[];
  trades: TradeRecord[];
  hints: StockExchangeHint[];
  insightsEmptyText: string;
  shipId?: string;
  cash: number;
  docked: boolean;
  activeHint: StockExchangeHint | null;
  onSelectEquity: (eqId: string) => void;
  onSell: (eqId: string, qty: number) => void;
  onCover: (eqId: string, qty: number) => void;
  onAbandon: (eqId: string) => void;
  onSetStopLoss: (eqId: string, price: number | null) => void;
  onSetTakeProfit: (eqId: string, price: number | null) => void;
}) {
  const tab = useStore((s) => s.pnoTab);
  const setTab = useStore((s) => s.setPnoTab);
  // Recompute every render — props.world is mutated in place, so a stable
  // reference would let useMemo cache stale values across action ticks.
  // Both lists are cheap (small array iteration).
  const limits = listPlayerLimits(props.world, props.shipId);
  const futures = listPlayerFutures(props.world);
  const insightHints = props.hints.filter(h => h.action !== "watch");
  const guidePositions = props.activeHint?.action === "cover";
  const guideFutures = props.activeHint?.action === "close_future";

  return (
    <section className="stocks-shell-panel stocks-pno">
      <div className="bridge-card-tabs stocks-pno-tabs">
        <button
          className={`bridge-tab ${tab === "positions" ? "active" : ""} ${guidePositions ? "has-suggestion" : ""}`}
          onClick={() => setTab("positions")}
          title={guidePositions ? `Close ${props.activeHint?.ticker} from positions` : undefined}
        >
          Positions <span className="bridge-tab-count">{props.positions.length}</span>
        </button>
        <button
          className={`bridge-tab ${tab === "orders" ? "active" : ""}`}
          onClick={() => setTab("orders")}
        >
          Orders <span className="bridge-tab-count">{limits.length}</span>
        </button>
        <button
          className={`bridge-tab ${tab === "futures" ? "active" : ""} ${guideFutures ? "has-suggestion" : ""}`}
          onClick={() => setTab("futures")}
          title={guideFutures ? `Close ${props.activeHint?.ticker} futures` : undefined}
        >
          Futures <span className="bridge-tab-count">{futures.length}</span>
        </button>
        <button
          className={`bridge-tab ${tab === "history" ? "active" : ""}`}
          onClick={() => setTab("history")}
        >
          History <span className="bridge-tab-count">{props.trades.length}</span>
        </button>
        <button
          className={`bridge-tab ${tab === "insights" ? "active" : ""}`}
          onClick={() => setTab("insights")}
        >
          Insights <span className="bridge-tab-count">{insightHints.length}</span>
        </button>
      </div>
      <div className="stocks-pno-body" data-scroll-key={`exchange:pno:${tab}`}>
        {tab === "positions" && (
          <PositionsAccordion
            world={props.world}
            positions={props.positions}
            shipId={props.shipId}
            cash={props.cash}
            docked={props.docked}
            activeHint={props.activeHint}
            onSelectEquity={props.onSelectEquity}
            onSell={props.onSell}
            onCover={props.onCover}
            onAbandon={props.onAbandon}
            onSetStopLoss={props.onSetStopLoss}
            onSetTakeProfit={props.onSetTakeProfit}
          />
        )}
        {tab === "orders" && (
          <OrdersAccordion world={props.world} limits={limits} onSelectEquity={props.onSelectEquity} />
        )}
        {tab === "futures" && (
          <FuturesPositionsList world={props.world} futures={futures} docked={props.docked} activeHint={props.activeHint} onSelectEquity={props.onSelectEquity} />
        )}
        {tab === "history" && (
          <TradesList trades={props.trades} onSelect={props.onSelectEquity} />
        )}
        {tab === "insights" && (
          <InsightsList hints={insightHints} activeHint={props.activeHint} onSelect={props.onSelectEquity} emptyText={props.insightsEmptyText} />
        )}
      </div>
    </section>
  );
});

// --- positions accordion (multi-expand) ---------------------------------

function PositionsAccordion(props: {
  world: World;
  positions: StockPosition[];
  shipId?: string;
  cash: number;
  docked: boolean;
  activeHint: StockExchangeHint | null;
  onSelectEquity: (eqId: string) => void;
  onSell: (eqId: string, qty: number) => void;
  onCover: (eqId: string, qty: number) => void;
  onAbandon: (eqId: string) => void;
  onSetStopLoss: (eqId: string, price: number | null) => void;
  onSetTakeProfit: (eqId: string, price: number | null) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (props.positions.length === 0) {
    return <div className="stocks-pno-empty dim">No open positions.</div>;
  }
  return (
    <SortableRows
      rows={props.positions}
      columns={[
        { id: "ticker", label: "ticker", getValue: pos => props.world.equities[pos.equityId]?.ticker ?? pos.equityId },
        { id: "side", label: "side", getValue: pos => pos.kind },
        { id: "shares", label: "shares", getValue: pos => pos.shares, defaultDirection: "desc" },
        { id: "avg", label: "average", getValue: pos => pos.avgEntryPrice, defaultDirection: "desc" },
        { id: "pnl", label: "profit/loss", getValue: pos => unrealizedPnl(props.world, pos), defaultDirection: "desc" },
      ]}
    >
      {(sortedPositions, sort) => (
        <div className="stocks-pno-list" data-scroll-key="exchange:pno:positions:list">
          <div className="stocks-pno-header positions">
            <SortableHeaderButton sort={sort} columnId="ticker">Ticker</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="side">Side</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="shares" className="numeric">Shares</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="avg" className="numeric">Avg</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="pnl" className="numeric">P&amp;L</SortableHeaderButton>
          </div>
          {sortedPositions.map(pos => {
            const eq = props.world.equities[pos.equityId];
            if (!eq) return null;
            const isOpen = expandedId === pos.equityId;
            return (
              <PositionAccordionItem
                key={pos.equityId}
                world={props.world}
                equity={eq}
                position={pos}
                shipId={props.shipId}
                cash={props.cash}
                docked={props.docked}
                activeHint={props.activeHint}
                isOpen={isOpen}
                onToggle={() => {
                  setExpandedId(isOpen ? null : pos.equityId);
                  props.onSelectEquity(pos.equityId);
                }}
                onSell={(qty) => props.onSell(pos.equityId, qty)}
                onCover={(qty) => props.onCover(pos.equityId, qty)}
                onAbandon={() => props.onAbandon(pos.equityId)}
                onSetStopLoss={(price) => props.onSetStopLoss(pos.equityId, price)}
                onSetTakeProfit={(price) => props.onSetTakeProfit(pos.equityId, price)}
              />
            );
          })}
        </div>
      )}
    </SortableRows>
  );
}

function PositionAccordionItem(props: {
  world: World;
  equity: Equity;
  position: StockPosition;
  shipId?: string;
  cash: number;
  docked: boolean;
  activeHint: StockExchangeHint | null;
  isOpen: boolean;
  onToggle: () => void;
  onSell: (qty: number) => void;
  onCover: (qty: number) => void;
  onAbandon: () => void;
  onSetStopLoss: (price: number | null) => void;
  onSetTakeProfit: (price: number | null) => void;
}) {
  const placeLimitSellAction = useStore(s => s.placeLimitSell);
  const placeLimitBuyAction = useStore(s => s.placeLimitBuy);
  const eq = props.equity;
  const pos = props.position;
  const longSign = pos.kind === "long" ? 1 : -1;
  const mark = eq.price;
  const value = mark * pos.shares;
  const cost = pos.avgEntryPrice * pos.shares;
  const unrealized = (mark - pos.avgEntryPrice) * pos.shares * longSign;
  const unrealizedPct = pos.avgEntryPrice > 0 ? (unrealized / (pos.avgEntryPrice * pos.shares)) * 100 : 0;
  const tone = unrealized > 0 ? "good" : unrealized < 0 ? "bad" : "";
  const ageTicks = props.world.tick - pos.openedAt;

  // Distance from mark to triggers — null if no trigger set. Phrased so a
  // negative number always means "danger" relative to mark.
  const slDistPct = pos.stopLoss != null && mark > 0
    ? ((pos.stopLoss - mark) / mark) * 100 * longSign
    : null;
  const tpDistPct = pos.takeProfit != null && mark > 0
    ? ((pos.takeProfit - mark) / mark) * 100 * longSign
    : null;

  const [closeQty, setCloseQty] = useState<number>(pos.shares);
  const [closePrice, setClosePrice] = useState<number>(mark);
  const [stopPrice, setStopPrice] = useState<string>(pos.stopLoss?.toFixed(2) ?? "");
  const [takePrice, setTakePrice] = useState<string>(pos.takeProfit?.toFixed(2) ?? "");
  const coverHint = props.activeHint?.action === "cover" && props.activeHint.equityId === eq.id && pos.kind === "short"
    ? props.activeHint
    : null;
  const suggestedCloseQty = coverHint?.suggestedUnits != null
    ? Math.max(1, Math.min(pos.shares, Math.floor(coverHint.suggestedUnits)))
    : null;
  const closeQtyNeedsGuide = props.isOpen && suggestedCloseQty != null && Math.round(closeQty) !== suggestedCloseQty;
  const closeReadyForGuide = props.isOpen
    && coverHint?.executable === true
    && props.docked
    && closeQty > 0
    && (suggestedCloseQty == null || Math.round(closeQty) === suggestedCloseQty);

  const placeLimitClose = () => {
    if (pos.kind === "long") placeLimitSellAction(eq.id, closeQty, closePrice);
    else placeLimitBuyAction(eq.id, closeQty, closePrice);
  };

  return (
    <div className={`stocks-accordion-item ${props.isOpen ? "open" : ""} ${pos.kind}`}>
      <button type="button" className="stocks-accordion-summary" onClick={props.onToggle}>
        <StockGuidanceCell
          guided={!!coverHint && !props.isOpen}
          hintText={`Open ${eq.ticker}'s short position controls.`}
        >
          <span className="ticker mono">{eq.ticker}</span>
        </StockGuidanceCell>
        <span className="kind-pill mono">{pos.kind === "long" ? "LONG" : "SHORT"}</span>
        <span className="numeric mono">{Math.round(pos.shares)} sh</span>
        <span className="numeric mono dim">@ Ç{fmtPrice(pos.avgEntryPrice)}</span>
        <span className={`numeric mono pnl ${tone}`}>
          {unrealized >= 0 ? "+" : ""}Ç{Math.round(unrealized).toLocaleString()}
          <span className="dim"> ({unrealized >= 0 ? "+" : ""}{unrealizedPct.toFixed(1)}%)</span>
        </span>
      </button>
      {props.isOpen && (
        <div className="stocks-accordion-body">
          <dl className="trade-helper-grid station-info-grid">
            <FleetStat label="mark" value={`Ç${fmtPrice(mark)}`} />
            <FleetStat label="avg cost" value={`Ç${fmtPrice(pos.avgEntryPrice)}`} />
            <FleetStat label="value" value={`Ç${Math.round(value).toLocaleString()}`} />
            <FleetStat label="exposure" value={`Ç${Math.round(cost).toLocaleString()}`} />
            <FleetStat label="P&L" value={`${unrealized >= 0 ? "+" : ""}Ç${Math.round(unrealized).toLocaleString()} (${unrealized >= 0 ? "+" : ""}${unrealizedPct.toFixed(1)}%)`} />
            <FleetStat label="held for" value={`${ageTicks.toLocaleString()}t`} />
          </dl>

          <section className="trade-helper-section">
            <div className="stocks-position-row close">
              <StockGuidanceCell
                guided={closeQtyNeedsGuide}
                hintText={suggestedCloseQty != null ? `Set cover quantity to ${suggestedCloseQty.toLocaleString()} sh.` : ""}
                onPingClick={() => suggestedCloseQty != null && setCloseQty(suggestedCloseQty)}
                className="field"
              >
                <label className="stocks-position-field">
                  <span>Qty</span>
                  <input type="number" min={1} max={pos.shares} value={closeQty}
                    onChange={e => setCloseQty(Math.max(1, Math.min(pos.shares, Math.floor(Number(e.target.value) || 0))))} />
                </label>
              </StockGuidanceCell>
              <label className="stocks-position-field">
                <span>Limit price</span>
                <input type="number" step="0.01" value={closePrice.toFixed(2)}
                  onChange={e => setClosePrice(Math.max(0.01, Number(e.target.value) || 0))} />
              </label>
              <button className="stocks-position-spot" onClick={() => setClosePrice(mark)}>Spot</button>
              <button
                className="btn-action"
                disabled={!props.docked || closeQty <= 0 || closePrice <= 0}
                onClick={placeLimitClose}
              >
                Place limit
              </button>
              <StockGuidanceCell
                guided={closeReadyForGuide}
                hintText={coverHint ? `Execute ${coverHint.actionLabel.toLowerCase()}.` : ""}
                onPingClick={() => (pos.kind === "long" ? props.onSell(closeQty) : props.onCover(closeQty))}
              >
                <button
                  className="btn-action primary"
                  disabled={!props.docked || closeQty <= 0}
                  onClick={() => (pos.kind === "long" ? props.onSell(closeQty) : props.onCover(closeQty))}
              >
                  {pos.kind === "long" ? "Sell qty" : "Cover qty"}
                </button>
              </StockGuidanceCell>
            </div>
            <div className="stocks-position-quick-row">
              <div className="stocks-position-quick-group">
                {[25, 50, 100].map(pct => {
                  const shares = Math.max(1, Math.round(pos.shares * pct / 100));
                  return (
                    <QuickChip
                      key={pct}
                      label={`${pct}%`}
                      hoverLabel={`${shares.toLocaleString()} sh`}
                      onClick={() => setCloseQty(shares)}
                    />
                  );
                })}
              </div>
              <div className="stocks-position-quick-group">
                {[1, 2, 5].map(pct => {
                  const target = mark * (1 + (pct / 100) * longSign);
                  return (
                    <QuickChip
                      key={pct}
                      label={`${pos.kind === "long" ? "+" : "−"}${pct}%`}
                      hoverLabel={`Ç${fmtPrice(target)}`}
                      className={pos.kind === "long" ? "tp" : "sl"}
                      onClick={() => setClosePrice(Math.max(0.01, target))}
                    />
                  );
                })}
              </div>
            </div>
          </section>

          <section className="trade-helper-section">
            <div className="stocks-trigger-grid">
              <TriggerCell
                label="Stop-loss"
                kind="sl"
                value={pos.stopLoss}
                distPct={slDistPct}
                inputValue={stopPrice}
                mark={mark}
                pctSign={(-longSign) as 1 | -1}
                onInputChange={setStopPrice}
                onSet={() => {
                  const v = Number(stopPrice);
                  if (Number.isFinite(v) && v > 0) props.onSetStopLoss(v);
                }}
                onClear={() => { props.onSetStopLoss(null); setStopPrice(""); }}
                onQuickPct={(pct) => {
                  // SL on long sits BELOW mark (negative pct from mark);
                  // SL on short sits ABOVE mark — multiply by -longSign.
                  const target = mark * (1 - pct / 100 * longSign);
                  setStopPrice(target.toFixed(2));
                }}
              />
              <TriggerCell
                label="Take-profit"
                kind="tp"
                value={pos.takeProfit}
                distPct={tpDistPct}
                inputValue={takePrice}
                mark={mark}
                pctSign={longSign as 1 | -1}
                onInputChange={setTakePrice}
                onSet={() => {
                  const v = Number(takePrice);
                  if (Number.isFinite(v) && v > 0) props.onSetTakeProfit(v);
                }}
                onClear={() => { props.onSetTakeProfit(null); setTakePrice(""); }}
                onQuickPct={(pct) => {
                  // TP on long sits ABOVE mark; on short BELOW.
                  const target = mark * (1 + pct / 100 * longSign);
                  setTakePrice(target.toFixed(2));
                }}
              />
            </div>
          </section>

          <section className="trade-helper-section stocks-position-danger">
            <div className="stocks-position-danger-row">
              <span className="dim">Force-close at a 5% penalty.</span>
              <button className="btn-action stocks-position-abandon" onClick={props.onAbandon}>
                Abandon
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

// A small chip button that shows "+5%" by default and the actual computed
// value (e.g. "Ç78.45") on hover. Used everywhere we have quick-% nudges
// (close-position qty/price, triggers, order accordion qty/price).
function QuickChip(props: {
  label: string;
  hoverLabel: string;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`stocks-trigger-chip ${props.className ?? ""}`} onClick={props.onClick}>
      <span className="chip-default">{props.label}</span>
      <span className="chip-hover">{props.hoverLabel}</span>
    </button>
  );
}

// One side of the Triggers row — stop-loss or take-profit. Renders as:
//   header: label + current value with distance-from-mark
//   input row: price input · Set · Clear
//   quick %: 2% · 5% · 10% (clicking sets the input to that distance from mark)
function TriggerCell(props: {
  label: string;
  kind: "sl" | "tp";
  value: number | undefined;
  distPct: number | null;
  inputValue: string;
  mark: number;
  pctSign: 1 | -1;     // sign applied to pct when computing target price
  onInputChange: (v: string) => void;
  onSet: () => void;
  onClear: () => void;
  onQuickPct: (pct: number) => void;
}) {
  return (
    <div className={`stocks-trigger-cell ${props.kind}`}>
      <div className="trade-helper-line">
        <span>{props.label}</span>
        <span className="mono">
          {props.value != null
            ? <>Ç{fmtPrice(props.value)} <span className="dim">({props.distPct! >= 0 ? "+" : ""}{props.distPct!.toFixed(1)}%)</span></>
            : <span className="dim">not set</span>}
        </span>
      </div>
      <div className="stocks-trigger-controls">
        <input type="number" step="0.01" placeholder="—" value={props.inputValue}
          onChange={e => props.onInputChange(e.target.value)} />
        <button className="btn-action btn-narrow" disabled={!props.inputValue} onClick={props.onSet}>Set</button>
        <button className="btn-action btn-narrow" disabled={props.value == null} onClick={props.onClear}>Clear</button>
      </div>
      <div className="stocks-trigger-quick">
        {[2, 5, 10].map(pct => {
          const target = props.mark * (1 + (pct / 100) * props.pctSign);
          return (
            <QuickChip
              key={pct}
              label={`${props.pctSign > 0 ? "+" : "−"}${pct}%`}
              hoverLabel={`Ç${fmtPrice(target)}`}
              onClick={() => props.onQuickPct(pct)}
            />
          );
        })}
      </div>
    </div>
  );
}

// --- orders accordion ---------------------------------------------------

function OrdersAccordion({ world, limits, onSelectEquity }: {
  world: World;
  limits: PlayerLimitView[];
  onSelectEquity: (eqId: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const cancelLimit = useStore(s => s.cancelLimit);
  const adjustLimit = useStore(s => s.adjustLimit);

  if (limits.length === 0) return <div className="stocks-pno-empty dim">No open orders.</div>;
  return (
    <SortableRows
      rows={limits}
      columns={[
        { id: "ticker", label: "ticker", getValue: order => order.ticker },
        { id: "side", label: "side", getValue: order => order.side },
        { id: "shares", label: "shares", getValue: order => order.qty, defaultDirection: "desc" },
        { id: "limit", label: "limit", getValue: order => order.limitPrice, defaultDirection: "desc" },
        { id: "age", label: "age", getValue: order => world.tick - order.postedAt, defaultDirection: "desc" },
      ]}
    >
      {(sortedLimits, sort) => (
        <div className="stocks-pno-list" data-scroll-key="exchange:pno:orders:list">
          <div className="stocks-pno-header orders">
            <SortableHeaderButton sort={sort} columnId="ticker">Ticker</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="side">Side</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="shares" className="numeric">Shares</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="limit" className="numeric">Limit</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="age" className="numeric">Age</SortableHeaderButton>
          </div>
          {sortedLimits.map(o => {
            const isOpen = expandedId === o.orderId;
            return (
              <OrderAccordionItem
                key={o.orderId}
                world={world}
                order={o}
                isOpen={isOpen}
                onToggle={() => {
                  setExpandedId(isOpen ? null : o.orderId);
                  onSelectEquity(o.equityId);
                }}
                onCancel={() => cancelLimit(o.equityId, o.orderId)}
                onAdjust={(qty, price) => adjustLimit(o.equityId, o.orderId, qty, price)}
              />
            );
          })}
        </div>
      )}
    </SortableRows>
  );
}

function OrderAccordionItem({ world, order, isOpen, onToggle, onCancel, onAdjust }: {
  world: World;
  order: PlayerLimitView;
  isOpen: boolean;
  onToggle: () => void;
  onCancel: () => void;
  onAdjust: (qty: number, price: number) => void;
}) {
  const eq = world.equities[order.equityId];
  const mark = eq?.price ?? order.limitPrice;
  const [qty, setQty] = useState<number>(order.qty);
  const [price, setPrice] = useState<number>(order.limitPrice);
  const ageTicks = world.tick - order.postedAt;
  // Buy-side wants below mark (negative chip), sell-side wants above
  // mark — flip the sign so the chip's sign always means "more
  // favorable than mark" for the player.
  const sideSign = order.side === "bid" ? -1 : 1;

  return (
    <div className={`stocks-accordion-item ${isOpen ? "open" : ""} ${order.side}`}>
      <button type="button" className="stocks-accordion-summary" onClick={onToggle}>
        <span className="ticker mono">{order.ticker}</span>
        <span className="kind-pill mono">{order.side === "bid" ? "BUY" : "SELL"}</span>
        <span className="numeric mono">{Math.round(order.qty)} sh</span>
        <span className="numeric mono dim">@ Ç{fmtPrice(order.limitPrice)}</span>
        <span className="numeric mono dim">age {ageTicks}t</span>
      </button>
      {isOpen && (
        <div className="stocks-accordion-body">
          <div className="stocks-position-row close">
            <label className="stocks-position-field">
              <span>Qty</span>
              <input type="number" min={1} value={qty}
                onChange={e => setQty(Math.max(1, Math.floor(Number(e.target.value) || 0)))} />
            </label>
            <label className="stocks-position-field">
              <span>Limit price</span>
              <input type="number" step="0.01" value={price.toFixed(2)}
                onChange={e => setPrice(Math.max(0.01, Number(e.target.value) || 0))} />
            </label>
            <button className="stocks-position-spot" onClick={() => setPrice(mark)}>Spot</button>
            <button className="btn-action" onClick={() => onAdjust(qty, price)}>Adjust</button>
            <button className="btn-action stocks-position-abandon" onClick={onCancel}>Cancel</button>
          </div>
          <div className="stocks-position-quick-row">
            <div className="stocks-position-quick-group">
              {[25, 50, 100].map(pct => {
                const shares = Math.max(1, Math.round(order.qty * pct / 100));
                return (
                  <QuickChip
                    key={pct}
                    label={`${pct}%`}
                    hoverLabel={`${shares.toLocaleString()} sh`}
                    onClick={() => setQty(shares)}
                  />
                );
              })}
            </div>
            <div className="stocks-position-quick-group">
              {[1, 2, 5].map(pct => {
                const target = mark * (1 + (pct / 100) * sideSign);
                return (
                  <QuickChip
                    key={pct}
                    label={`${sideSign > 0 ? "+" : "−"}${pct}%`}
                    hoverLabel={`Ç${fmtPrice(target)}`}
                    className={order.side === "ask" ? "tp" : "sl"}
                    onClick={() => setPrice(Math.max(0.01, target))}
                  />
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- info column (right) -----------------------------------------------

function InfoColumn({ row, world, shipId, docked, hint, selectedHint, activeHint, guideEnabled, emptyText }: {
  row: EquityRow;
  world: World;
  shipId?: string;
  docked: boolean;
  hint: StockExchangeHint | null;
  selectedHint: StockExchangeHint | null;
  activeHint: StockExchangeHint | null;
  guideEnabled: boolean;
  emptyText: string;
}) {
  const eq = row.equity;
  const access = exchangeAccess(world, eq, shipId);
  const artUrl = equityArtUrl(world, eq);
  const [manualHint, setManualHint] = useState<StockExchangeHint | null>(null);
  const [hintApplyKey, setHintApplyKey] = useState(0);
  useEffect(() => {
    setManualHint(null);
    setHintApplyKey(0);
  }, [eq.id]);
  const formHint = manualHint && manualHint.equityId === eq.id ? manualHint : hint;
  const applySelectedHint = (nextHint: StockExchangeHint) => {
    if (nextHint.equityId !== eq.id) return;
    setManualHint(nextHint);
    setHintApplyKey(k => k + 1);
  };

  return (
    <section className="stocks-shell-panel stocks-info-col">
      <div
        className={`stocks-panel-head art-panel-head ${artUrl ? "" : "no-art"}`}
        style={artUrl ? artCardStyle(artUrl) : undefined}
      >
        <div className="stocks-info-title">
          <span className="stocks-info-eyebrow">{`Listed ${KIND_LABEL[eq.kind].toLowerCase()}`}</span>
          <span className="stocks-info-name">{eq.name}</span>
        </div>
        <div className="stocks-info-quote">
          <span className="price big mono">Ç{fmtPrice(eq.price)}</span>
          <ChangeCell pct={row.changePct} />
        </div>
      </div>

      <div className="stocks-info-body" data-scroll-key={`exchange:info:${eq.id}`}>
        <Sparkline equity={eq} position={row.position} />

        <div className="stocks-info-row">
          <KpiPanel row={row} world={world} />
          <CompanyUnderlying eq={eq} world={world} />
        </div>

        <div className="stocks-info-row">
          <OrderBookPanel equity={eq} world={world} />
          <TimeAndSalesPanel equity={eq} />
        </div>

        {eq.kind === "futures"
          ? <FuturesOrderForm equity={eq} world={world} docked={docked} access={access} hint={formHint} hintApplyKey={hintApplyKey} />
          : <UnifiedOrderForm equity={eq} world={world} docked={docked} access={access} hint={formHint} hintApplyKey={hintApplyKey} />}
      </div>
      <StockHintChin
        hint={selectedHint}
        guided={activeHint != null && selectedHint != null && activeHint.equityId === selectedHint.equityId && activeHint.action === selectedHint.action}
        guideEnabled={guideEnabled}
        clickMode="applyHint"
        labelMode="action"
        rightDetailLayout
        marqueeOverflow
        onApplyHint={applySelectedHint}
        showEnabledState={false}
        emptyText={emptyText}
      />
    </section>
  );
}

function StockHintChin({ hint, guided, guideEnabled, onGuideToggle, onApplyHint, emptyText, showEnabledState = true, clickMode = "toggleGuide", labelMode = "actionTicker", rightDetailLayout = false, marqueeOverflow = false }: {
  hint: StockExchangeHint | null;
  guided: boolean;
  guideEnabled: boolean;
  onGuideToggle?: () => void;
  onApplyHint?: (hint: StockExchangeHint) => void;
  emptyText: string;
  showEnabledState?: boolean;
  clickMode?: "toggleGuide" | "applyHint";
  labelMode?: "actionTicker" | "action";
  rightDetailLayout?: boolean;
  marqueeOverflow?: boolean;
}) {
  const meta = hint
    ? [
      hintQuantityMeta(hint),
      `edge ${fmtPct(hint.edgePct)}`,
      hint.suggestedLimitPrice != null ? `limit Ç${fmtPrice(hint.suggestedLimitPrice)}` : null,
      hint.workingOrderUnits != null
        ? `working ${Math.round(hint.workingOrderUnits).toLocaleString()} ${hint.unitLabel ?? "sh"}${hint.workingOrderLimitPrice != null ? ` @ Ç${fmtPrice(hint.workingOrderLimitPrice)}` : ""}`
        : null,
    ].filter(Boolean).join(" · ")
    : emptyText;
  const title = hint?.executable === false
    ? hint.blockReason ?? hint.reason
    : hint?.reason ?? emptyText;
  const handleClick = () => {
    if (clickMode === "toggleGuide") {
      onGuideToggle?.();
      return;
    }
    if (hint) onApplyHint?.(hint);
  };
  const renderText = (className: string, text: string) => marqueeOverflow
    ? <OverflowMarquee className={className} title={text}>{text}</OverflowMarquee>
    : <span className={className}>{text}</span>;

  return (
    <button
      type="button"
      className={`stocks-hint-chin ${rightDetailLayout ? "right-detail" : ""} ${hint ? hint.action : "empty"} ${guided ? "guided" : ""} ${showEnabledState && guideEnabled ? "enabled" : ""} ${hint?.executable === false ? "blocked" : ""}`}
      aria-pressed={clickMode === "toggleGuide" ? guideEnabled : undefined}
      onClick={handleClick}
      title={title}
    >
      {hint ? (
        <>
          <span className={`stocks-hint-chin-action ${hint.action}`}>{compactHintActionLabel(hint, labelMode)}</span>
          {renderText("stocks-hint-chin-reason", hint.reason)}
          <span className="stocks-hint-chin-meta" title={meta}>{meta}</span>
        </>
      ) : (
        renderText("stocks-hint-chin-empty dim", emptyText)
      )}
    </button>
  );
}

function OverflowMarquee({ className, children, title }: {
  className: string;
  children: ReactNode;
  title?: string;
}) {
  const shellRef = useRef<HTMLSpanElement>(null);
  const trackRef = useRef<HTMLSpanElement>(null);
  const [distance, setDistance] = useState(0);

  useEffect(() => {
    const shell = shellRef.current;
    const track = trackRef.current;
    if (!shell || !track) return;

    const measure = () => {
      setDistance(Math.max(0, Math.ceil(track.scrollWidth - shell.clientWidth)));
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(measure);
    observer.observe(shell);
    observer.observe(track);
    return () => observer.disconnect();
  }, [children]);

  const overflowing = distance > 1;
  const duration = Math.min(14, Math.max(7, distance / 18 + 6));

  return (
    <span
      className={`${className} stocks-overflow-marquee ${overflowing ? "overflowing" : ""}`}
      ref={shellRef}
      style={{
        "--stocks-marquee-distance": `${distance}px`,
        "--stocks-marquee-duration": `${duration}s`,
      } as CSSProperties}
      title={title}
    >
      <span className="stocks-overflow-marquee-track" ref={trackRef}>{children}</span>
    </span>
  );
}

function compactHintActionLabel(hint: StockExchangeHint, mode: "actionTicker" | "action" | "full" = "full"): string {
  const units = mode === "full" && hint.suggestedUnits != null
    ? ` ${Math.max(1, Math.floor(hint.suggestedUnits)).toLocaleString()}`
    : "";
  const ticker = mode === "action" ? "" : ` ${hint.ticker}`;
  switch (hint.action) {
    case "buy": return `BUY${units}${ticker}`;
    case "sell": return `SELL${units}${ticker}`;
    case "short": return `SHORT${units}${ticker}`;
    case "cover": return `COVER${units}${ticker}`;
    case "open_long_future": return `LONG${units}${ticker}`;
    case "open_short_future": return `SHORT${units}${ticker}`;
    case "close_future": return `CLOSE${units}${ticker}`;
    case "watch": return `WATCH${ticker}`;
  }
}

function hintQuantityMeta(hint: StockExchangeHint): string | null {
  if (hint.suggestedUnits == null) return null;
  const units = Math.max(1, Math.floor(hint.suggestedUnits)).toLocaleString();
  return `qty • ${units}${hint.unitLabel ? ` ${hint.unitLabel}` : ""}`;
}

function KpiPanel({ row, world }: { row: EquityRow; world: World }) {
  const eq = row.equity;
  const dividend = eq.lastDividend?.perShare ?? 0;
  const book = world.orderBooks?.[eq.id];
  const bestBid = book?.bids[0]?.limitPrice;
  const bestAsk = book?.asks[0]?.limitPrice;
  const spreadPct = bestBid != null && bestAsk != null && bestBid > 0
    ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 100
    : null;

  const trades = eq.recentTrades ?? [];
  const windowQty = trades.reduce((s, t) => s + t.qty, 0);
  const windowHigh = trades.reduce((m, t) => Math.max(m, t.price), 0);
  const windowLow = trades.length > 0 ? trades.reduce((m, t) => Math.min(m, t.price), Infinity) : 0;

  return (
    <section className="trade-helper-section stocks-kpi">
      <div className="exchange-section-title">KPI</div>
      <dl className="trade-helper-grid station-info-grid">
        <FleetStat label="bid" value={bestBid != null ? `Ç${fmtPrice(bestBid)}` : "—"} />
        <FleetStat label="ask" value={bestAsk != null ? `Ç${fmtPrice(bestAsk)}` : "—"} />
        <FleetStat label="spread" value={spreadPct != null ? `${spreadPct.toFixed(2)}%` : "—"} />
        <FleetStat label="vs IPO" value={`${row.ratioToAnchor.toFixed(2)}x`} />
        <FleetStat label="vol" value={Math.round(windowQty).toLocaleString()} />
        <FleetStat label="high" value={trades.length > 0 ? `Ç${fmtPrice(windowHigh)}` : "—"} />
        <FleetStat label="low" value={trades.length > 0 ? `Ç${fmtPrice(windowLow)}` : "—"} />
        <FleetStat label="shares" value={eq.sharesOutstanding.toLocaleString()} />
        <FleetStat label="dividend" value={dividend > 0 ? `Ç${dividend.toFixed(2)}/sh` : "none"} />
        <FleetStat label="next div" value={`${row.ticksUntilDividend}t`} />
      </dl>
    </section>
  );
}

// Mirrors the Stat component used by the fleet view — same classes
// (.cargo-stat with dim label + mono value) so the visual style is
// guaranteed identical across views.
function FleetStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="cargo-stat">
      <dt className="dim">{label}</dt>
      <dd className="mono info-value">{value}</dd>
    </div>
  );
}

// Unified order form — Buy / Sell / Short with qty + price + "Use Spot".
// Spot = limit at the current eq.price (still goes into the book; the
// matching engine fills it immediately if there's a crossing counterparty,
// or rests it otherwise).
function UnifiedOrderForm({ equity, world, docked, access, hint, hintApplyKey = 0 }: {
  equity: Equity;
  world: World;
  docked: boolean;
  access: { ok: boolean; reason: string };
  hint: StockExchangeHint | null;
  hintApplyKey?: number;
}) {
  const placeLimitBuy = useStore(s => s.placeLimitBuy);
  const placeLimitSell = useStore(s => s.placeLimitSell);
  const shortShares = useStore(s => s.shortShares);

  type Side = "buy" | "sell" | "short";
  const [side, setSide] = useState<Side>("buy");
  const [qty, setQty] = useState<number>(10);
  const [price, setPrice] = useState<number>(equity.price);

  const lastEqRef = useRef(equity.id);
  const lastAppliedHintRef = useRef("");
  useEffect(() => {
    if (lastEqRef.current !== equity.id) {
      lastEqRef.current = equity.id;
      setPrice(equity.price);
      lastAppliedHintRef.current = "";
    }
  }, [equity.id, equity.price]);

  useEffect(() => {
    if (!hint || hint.equityId !== equity.id) return;
    const key = `${hint.equityId}:${hint.action}:${hint.suggestedUnits ?? ""}:${hint.suggestedLimitPrice ?? ""}:${hintApplyKey}`;
    if (lastAppliedHintRef.current === key) return;
    if (hint.action === "buy") setSide("buy");
    else if (hint.action === "sell") setSide("sell");
    else if (hint.action === "short") setSide("short");
    else return;
    if (hint.suggestedUnits != null) setQty(Math.max(1, Math.floor(hint.suggestedUnits)));
    setPrice(hint.suggestedLimitPrice ?? equity.price);
    lastAppliedHintRef.current = key;
  }, [equity.id, equity.price, hint, hintApplyKey]);

  const playerShipId = useSelectedPlayerShipId(world);
  const ship = playerShipId ? world.traders[playerShipId] : null;
  const position = ship?.stockPositions?.[equity.id];
  const mark = equity.price;

  // Per-side max qty for the % chips. For buy/short we estimate by funds /
  // mark — the actual order is bounded by float and book depth at submit
  // time, but this gives the player a useful "can I afford 25%/50%/100%
  // of what I might buy here" feel.
  const maxByFunds = ship && mark > 0 ? Math.floor(ship.funds / (mark * (1 + BROKER_FEE_RATE))) : 0;
  const heldQty = position?.kind === "long" ? position.shares : 0;
  const shortableQty = maxShortableShares(world, equity, playerShipId);
  const sideMax = side === "buy" ? maxByFunds : side === "sell" ? heldQty : shortableQty;
  const guidedAction = isShareOrderHint(hint) && hint.equityId === equity.id ? hint.action : null;
  const suggestedQty = guidedAction && hint?.suggestedUnits != null
    ? Math.max(1, Math.floor(hint.suggestedUnits))
    : null;
  const suggestedLimitPrice = guidedAction && guidedAction !== "short"
    ? hint?.suggestedLimitPrice ?? equity.price
    : null;
  const qtyNeedsGuide = suggestedQty != null && Math.round(qty) !== suggestedQty;
  const priceNeedsGuide = suggestedLimitPrice != null && Math.abs(price - suggestedLimitPrice) > 0.005;
  const readyForGuidedSubmit = guidedAction != null
    && hint?.executable === true
    && docked
    && access.ok
    && side === guidedAction
    && qty > 0
    && (suggestedQty == null || Math.round(qty) === suggestedQty)
    && (suggestedLimitPrice == null || (price > 0 && Math.abs(price - suggestedLimitPrice) <= 0.005));

  const total = qty * price;
  const fee = total * BROKER_FEE_RATE;
  const summary = side === "buy"
    ? `Reserve Ç${Math.round(total + fee).toLocaleString()}`
    : side === "sell"
      ? `Net Ç${Math.round(total - fee).toLocaleString()} on fill`
      : `Short proceeds ~Ç${Math.round(total - fee).toLocaleString()}`;

  const submit = () => {
    if (side === "buy") placeLimitBuy(equity.id, qty, price);
    else if (side === "sell") placeLimitSell(equity.id, qty, price);
    else shortShares(equity.id, qty);   // short uses market for now
  };

  // For short: aggressive market order direction. The price chip's sign
  // mirrors the position-close UI: long uses +Δ to push the take-profit
  // up, short uses −Δ. For order entry, "+" means a higher limit price
  // (more aggressive on a buy, less aggressive on a sell).
  const priceSign = side === "sell" ? -1 : 1;

  return (
    <section className="trade-helper-section stocks-order-form">
      <div className="exchange-section-title">Place order</div>
      <div className="stocks-order-side">
        {(["buy", "sell", "short"] as Side[]).map(sideName => (
          <StockGuidanceCell
            key={sideName}
            guided={guidedAction === sideName && side !== sideName}
            hintText={`Choose ${sideName === "buy" ? "buy" : sideName === "sell" ? "sell" : "short"} for ${equity.ticker}.`}
            onPingClick={() => setSide(sideName)}
          >
            <button className={`stocks-order-side-btn ${sideName} ${side === sideName ? "active" : ""}`} onClick={() => setSide(sideName)}>
              {sideName === "buy" ? "Buy" : sideName === "sell" ? "Sell" : "Short"}
            </button>
          </StockGuidanceCell>
        ))}
      </div>
      <div className="stocks-order-fields">
        <StockGuidanceCell
          guided={qtyNeedsGuide}
          hintText={suggestedQty != null ? `Set quantity to ${suggestedQty.toLocaleString()} sh.` : ""}
          onPingClick={() => suggestedQty != null && setQty(suggestedQty)}
          className="field"
        >
          <label>
            <span>Qty</span>
            <input type="number" min={1} value={qty}
              onChange={e => setQty(Math.max(1, Math.floor(Number(e.target.value) || 0)))} />
          </label>
        </StockGuidanceCell>
        <StockGuidanceCell
          guided={priceNeedsGuide}
          hintText={suggestedLimitPrice != null ? `Set limit price to Ç${fmtPrice(suggestedLimitPrice)}.` : ""}
          onPingClick={() => suggestedLimitPrice != null && setPrice(suggestedLimitPrice)}
          className="field"
        >
          <label>
            <span>Price</span>
            <input type="number" step="0.01" value={price.toFixed(2)}
              onChange={e => setPrice(Math.max(0.01, Number(e.target.value) || 0))}
              disabled={side === "short"} />
          </label>
        </StockGuidanceCell>
        <button className="stocks-order-spot" onClick={() => setPrice(equity.price)} disabled={side === "short"}>
          Use spot
        </button>
      </div>
      <div className="stocks-position-quick-row">
        <div className="stocks-position-quick-group">
          {[25, 50, 100].map(pct => {
            const target = Math.max(1, Math.round((sideMax || 0) * pct / 100));
            return (
              <QuickChip
                key={pct}
                label={`${pct}%`}
                hoverLabel={sideMax > 0 ? `${target.toLocaleString()} sh` : "—"}
                onClick={() => sideMax > 0 && setQty(target)}
              />
            );
          })}
        </div>
        <div className="stocks-position-quick-group">
          {[1, 2, 5].map(pct => {
            const delta = mark * (pct / 100) * priceSign;
            const target = Math.max(0.01, mark + delta);
            return (
              <QuickChip
                key={pct}
                label={`${priceSign > 0 ? "+" : "−"}${pct}%`}
                hoverLabel={`Ç${fmtPrice(target)}`}
                className={side === "sell" ? "sl" : "tp"}
                onClick={() => side !== "short" && setPrice(target)}
              />
            );
          })}
        </div>
      </div>
      <div className="stocks-order-summary dim">{summary}</div>
      <StockGuidanceCell
        guided={readyForGuidedSubmit}
        hintText={hint ? `Execute ${hint.actionLabel.toLowerCase()}.` : ""}
        onPingClick={submit}
        className="full"
      >
        <button
          className="btn-action primary stocks-order-submit"
          disabled={!docked || !access.ok || qty <= 0 || (side !== "short" && price <= 0)}
          onClick={submit}
        >
          Place {side === "buy" ? "Buy" : side === "sell" ? "Sell" : "Short"} Order
        </button>
      </StockGuidanceCell>
      {!docked && <div className="stocks-warning dim">Equity trades only execute while docked.</div>}
      {!access.ok && <div className="stocks-warning dim">{access.reason}</div>}
    </section>
  );
}

// C-3: futures-specific order form. Long/Short market opens through the
// futures API; margin reservation + fee shown up front. Limit orders for
// futures aren't surfaced yet — uses a market open against the existing
// agent quotes.
function FuturesOrderForm({ equity, world, docked, access, hint, hintApplyKey = 0 }: {
  equity: Equity;
  world: World;
  docked: boolean;
  access: { ok: boolean; reason: string };
  hint: StockExchangeHint | null;
  hintApplyKey?: number;
}) {
  const openLongFuture = useStore(s => s.openLongFuture);
  const openShortFuture = useStore(s => s.openShortFuture);
  const [count, setCount] = useState<number>(1);
  const lastAppliedHintRef = useRef("");
  // The +N chips behave as "set to N" on the first click and as
  // "add N to current" thereafter — labels switch from "N" to "+N"
  // accordingly. Reset whenever the user changes count by another
  // means (typing or % chip), so the next +N click starts a fresh
  // "set" interaction.
  const [incrementMode, setIncrementMode] = useState(false);
  const c = world.contracts?.[equity.id];
  const playerShipId = useSelectedPlayerShipId(world);
  const ship = playerShipId ? world.traders[playerShipId] : null;
  const existing = ship?.futures?.[equity.id];
  const hintKey = hint && hint.equityId === equity.id
    && (hint.action === "open_long_future" || hint.action === "open_short_future")
    ? `${hint.equityId}:${hint.action}:${hint.suggestedUnits ?? ""}:${hintApplyKey}`
    : "";
  useEffect(() => {
    if (!hintKey || !hint || lastAppliedHintRef.current === hintKey) return;
    if (hint.suggestedUnits != null) setCount(Math.max(1, Math.floor(hint.suggestedUnits)));
    setIncrementMode(false);
    lastAppliedHintRef.current = hintKey;
  }, [hintKey, hint]);
  if (!c) return null;
  const spot = world.equities[c.underlyingEquityId]?.price ?? equity.price;
  const notional = c.contractSize * spot * count;
  const margin = notional * c.marginFraction;
  const fee = notional * BROKER_FEE_RATE;
  const total = margin + fee;
  const ttx = Math.max(0, c.expiryTick - world.tick);
  const cantAfford = ship != null && ship.funds < total;
  // Max contracts the player can afford one shot.
  const marginPerContract = c.marginFraction * c.contractSize * spot;
  const feePerContract = c.contractSize * spot * BROKER_FEE_RATE;
  const maxContracts = ship && marginPerContract + feePerContract > 0
    ? Math.max(0, Math.floor(ship.funds / (marginPerContract + feePerContract)))
    : 0;
  const blockReason: string | null = !docked
    ? "Trade only while docked."
    : !access.ok
      ? access.reason
      : count <= 0
        ? "Choose at least 1 contract."
        : cantAfford
          ? `Need Ç${Math.round(total).toLocaleString()}, have Ç${Math.round(ship?.funds ?? 0).toLocaleString()}.`
          : null;
  const flipBlocked = (side: "long" | "short") =>
    existing != null && existing.side !== side
      ? `Currently ${existing.side} ${existing.contracts} ${equity.ticker}. Close before flipping.`
      : null;
  const longBlock = blockReason ?? flipBlocked("long");
  const shortBlock = blockReason ?? flipBlocked("short");
  const guidedFutureHint = isOpenFuturesHint(hint) && hint.equityId === equity.id ? hint : null;
  const guidedFutureAction = guidedFutureHint?.action ?? null;
  const suggestedCount = guidedFutureHint?.suggestedUnits != null
    ? Math.max(1, Math.floor(guidedFutureHint.suggestedUnits))
    : null;
  const countNeedsGuide = suggestedCount != null && count !== suggestedCount;
  const longReadyForGuide = guidedFutureAction === "open_long_future" && !longBlock && count > 0 && !countNeedsGuide;
  const shortReadyForGuide = guidedFutureAction === "open_short_future" && !shortBlock && count > 0 && !countNeedsGuide;

  return (
    <section className="trade-helper-section stocks-order-form">
      <div className="exchange-section-title">Open futures position</div>

      <div className="stocks-order-fields">
        <StockGuidanceCell
          guided={countNeedsGuide}
          hintText={suggestedCount != null ? `Set contracts to ${suggestedCount.toLocaleString()} ct.` : ""}
          onPingClick={() => {
            if (suggestedCount == null) return;
            setCount(suggestedCount);
            setIncrementMode(false);
          }}
          className="field"
          style={{ gridColumn: "1 / span 3" }}
        >
          <label>
            <span>Contracts</span>
            <input type="number" min={1} value={count}
              onChange={e => {
                setCount(Math.max(1, Math.floor(Number(e.target.value) || 0)));
                setIncrementMode(false);
              }} />
          </label>
        </StockGuidanceCell>
      </div>

      <div className="stocks-position-quick-row stocks-quick-row-flat">
        <div className="stocks-position-quick-group">
          {[25, 50, 100].map(pct => {
            const target = Math.max(1, Math.round(maxContracts * pct / 100));
            return (
              <QuickChip
                key={pct}
                label={`${pct}%`}
                hoverLabel={maxContracts > 0 ? `${target} ct (Ç${Math.round((marginPerContract + feePerContract) * target).toLocaleString()})` : "—"}
                onClick={() => {
                  if (maxContracts > 0) setCount(target);
                  setIncrementMode(false);
                }}
              />
            );
          })}
        </div>
        <div className="stocks-position-quick-group">
          {[1, 5, 10].map(n => (
            <QuickChip
              key={n}
              label={incrementMode ? `+${n}` : `${n}`}
              hoverLabel={incrementMode ? `+${n} contracts` : `${n} contracts`}
              onClick={() => {
                setCount(c => incrementMode ? c + n : n);
                setIncrementMode(true);
              }}
            />
          ))}
        </div>
      </div>

      <dl className="trade-helper-grid station-info-grid" style={{ marginTop: 6 }}>
        <FleetStat label="spot" value={`Ç${fmtPrice(spot)}`} />
        <FleetStat label="contract size" value={`${c.contractSize}`} />
        <FleetStat label="notional" value={`Ç${Math.round(notional).toLocaleString()}`} />
        <FleetStat label="margin" value={`Ç${Math.round(margin).toLocaleString()} (${(c.marginFraction * 100).toFixed(0)}%)`} />
        <FleetStat label="fee" value={`Ç${Math.round(fee).toLocaleString()}`} />
        <FleetStat label="expires in" value={`${ttx}t`} />
      </dl>

      <div className="stocks-order-side" style={{ marginTop: 8, gridTemplateColumns: "1fr 1fr" }}>
        <StockGuidanceCell
          guided={longReadyForGuide}
          hintText={hint ? `Execute ${hint.actionLabel.toLowerCase()}.` : ""}
          onPingClick={() => openLongFuture(equity.id, count)}
        >
          <button
            className="stocks-order-side-btn buy"
            disabled={longBlock != null}
            title={longBlock ?? undefined}
            onClick={() => openLongFuture(equity.id, count)}
          >
            Open Long · Ç{Math.round(total).toLocaleString()}
          </button>
        </StockGuidanceCell>
        <StockGuidanceCell
          guided={shortReadyForGuide}
          hintText={hint ? `Execute ${hint.actionLabel.toLowerCase()}.` : ""}
          onPingClick={() => openShortFuture(equity.id, count)}
        >
          <button
            className="stocks-order-side-btn short"
            disabled={shortBlock != null}
            title={shortBlock ?? undefined}
            onClick={() => openShortFuture(equity.id, count)}
          >
            Open Short · Ç{Math.round(total).toLocaleString()}
          </button>
        </StockGuidanceCell>
      </div>

      {existing && (
        <div className="stocks-warning dim" style={{ marginTop: 6 }}>
          You already hold {existing.contracts} {existing.side} {equity.ticker}. Adds in the same direction adjust your average; opposite-direction opens are blocked.
        </div>
      )}
      {blockReason && <div className="stocks-warning dim" style={{ marginTop: 6 }}>{blockReason}</div>}
    </section>
  );
}

export function StockRowsTable({ rows, selectedId, onSelect, outOfRange = false }: {
  rows: EquityRow[];
  selectedId: string | null;
  onSelect: (equityId: string) => void;
  outOfRange?: boolean;
}) {
  if (rows.length === 0) {
    return <div className="stocks-detail-empty dim">No reachable listings.</div>;
  }
  return (
    <SortableRows
      rows={rows}
      columns={[
        { id: "ticker", label: "ticker", getValue: row => row.equity.ticker },
        { id: "listing", label: "listing", getValue: row => row.equity.name },
        { id: "kind", label: "kind", getValue: row => row.kindLabel },
        { id: "price", label: "price", getValue: row => row.equity.price, defaultDirection: "desc" },
        { id: "change", label: "change", getValue: row => row.changePct, defaultDirection: "desc" },
        { id: "health", label: "health", getValue: row => row.underlyingHealth, defaultDirection: "desc" },
        { id: "dividend", label: "last dividend", getValue: row => row.lastDividendPerShare, defaultDirection: "desc" },
      ]}
    >
      {(sortedRows, sort) => (
        <table className={`stocks-table ${outOfRange ? "out-of-range" : ""}`}>
          <colgroup>
            <col className="col-ticker" />
            <col className="col-name" />
            <col className="col-kind" />
            <col className="col-price" />
            <col className="col-change" />
            <col className="col-health" />
            <col className="col-yield" />
          </colgroup>
          <thead>
            <tr>
              <SortableTh sort={sort} columnId="ticker">Ticker</SortableTh>
              <SortableTh sort={sort} columnId="listing">Listing</SortableTh>
              <SortableTh sort={sort} columnId="kind">Kind</SortableTh>
              <SortableTh sort={sort} columnId="price">Price</SortableTh>
              <SortableTh sort={sort} columnId="change">Δ</SortableTh>
              <SortableTh sort={sort} columnId="health">Health</SortableTh>
              <SortableTh sort={sort} columnId="dividend">Last Div</SortableTh>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(row => (
              <tr
                key={row.equity.id}
                className={[
                  selectedId === row.equity.id ? "active" : "",
                  row.changePct > 0.0005 ? "up" : row.changePct < -0.0005 ? "down" : "",
                  row.position?.kind === "long" ? "owned" : "",
                  row.position?.kind === "short" ? "shorted" : "",
                  outOfRange ? "out-of-range" : "",
                ].filter(Boolean).join(" ")}
                onClick={() => onSelect(row.equity.id)}
              >
                <td><span className="ticker mono">{row.equity.ticker}</span></td>
                <td>
                  <span className="stock-name-cell">
                    <span className="stock-name">{row.equity.name}</span>
                  </span>
                </td>
                <td><span className={`kind-pill kind-${row.equity.kind}`}>{row.kindLabel}</span></td>
                <td>
                  <span className="stock-stack">
                    <span className="mono price">Ç{fmtPrice(row.equity.price)}</span>
                  </span>
                </td>
                <td><ChangeCell pct={row.changePct} /></td>
                <td><HealthBar value={row.underlyingHealth} label={row.underlyingHealthLabel} /></td>
                <td>
                  {row.lastDividendPerShare > 0 ? (
                    <span className="mono" title={`${row.ticksUntilDividend}t to next dividend`}>
                      Ç{row.lastDividendPerShare.toFixed(2)}/sh
                    </span>
                  ) : (
                    <span className="dim">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SortableRows>
  );
}

// --- sidebar: company info + entry actions (Buy/Short) only ---------------
// The right sidebar is purely for browsing the company / opening new
// positions. Once a position exists, all close-side and risk controls live
// inside the focused row in the Positions panel on the left.

interface CompanyPaneProps {
  row: EquityRow;
  world: World;
  shipId?: string;
  cash: number;
  docked: boolean;
  hasOpposite: boolean;   // currently short → can't open long; (parity flag)
  hasLong: boolean;       // currently long → can't open short
  onBuy: (qty: number) => void;
  onShort: (qty: number) => void;
}

export function CompanyPane({ row, world, shipId, cash, docked, hasOpposite, hasLong, onBuy, onShort }: CompanyPaneProps) {
  const eq = row.equity;
  const pos = row.position;
  const [buyQty, setBuyQty] = useState<number>(10);
  const [shortQty, setShortQty] = useState<number>(10);
  const access = exchangeAccess(world, eq, shipId);

  const buyCost = buyQty * eq.price * (1 + BROKER_FEE_RATE);
  const shortProceeds = shortQty * eq.price * (1 - BROKER_FEE_RATE);
  const dividend = eq.lastDividend?.perShare ?? 0;

  const maxBuy = hasOpposite || !access.ok ? 0 : Math.max(0, Math.min(
    Math.floor(cash / Math.max(0.0001, eq.price * (1 + BROKER_FEE_RATE))),
    eq.sharesOutstanding - (pos?.shares ?? 0),
  ));
  const maxShort = hasLong || !access.ok ? 0 : Math.max(0, Math.min(
    eq.sharesOutstanding - (pos?.shares ?? 0),
    maxShortableShares(world, eq, shipId),
  ));

  return (
    <div className="stocks-info-frame">
      <div className="stocks-info-fixed">
        <EquityInfoHeader row={row} world={world} access={access} />
      </div>

      <div className="stocks-info-scroll">
        <Sparkline equity={eq} position={pos} />

        <dl className="stocks-info-grid">
          <InfoStat label="quote" value={`Ç${fmtPrice(eq.price)}`} />
          <InfoStat label="delta" value={fmtPct(row.changePct)} tone={row.changePct > 0 ? "good" : row.changePct < 0 ? "bad" : ""} />
          <InfoStat label="vs IPO" value={`${row.ratioToAnchor.toFixed(2)}x`} />
          <InfoStat label="shares" value={eq.sharesOutstanding.toLocaleString()} />
          <InfoStat label="dividend" value={dividend > 0 ? `Ç${dividend.toFixed(2)}/sh` : "none"} />
          <InfoStat label="next window" value={`${row.ticksUntilDividend}t`} />
        </dl>

        <OrderBookPanel equity={eq} world={world} />
        <TimeAndSalesPanel equity={eq} />
        <VolumePanel equity={eq} world={world} />

        <CompanyUnderlying eq={eq} world={world} />

        <div className="stocks-info-section">
          <div className="stocks-info-section-title">Access</div>
          <div className={`stocks-info-line ${access.ok ? "" : "blocked"}`}>
            <span>Status</span>
            <span className="mono">{access.label}</span>
          </div>
          {!access.ok && <div className="stocks-info-note">{access.reason}</div>}
        </div>

        <div className="stocks-info-section">
          <div className="stocks-info-section-title">Orders</div>
          <div className="stocks-trade-grid">
            <TradeSide
              label={pos?.kind === "long" ? "Buy more" : "Buy"}
              qty={buyQty}
              setQty={setBuyQty}
              max={maxBuy}
              costLabel={maxBuy <= 0 ? (hasOpposite ? "Cover the short first" : "—") : `Ç${Math.round(buyCost).toLocaleString()}`}
              disabled={!docked || maxBuy <= 0}
              disabledReason={!access.ok ? access.reason : hasOpposite ? "Cover the short first (in the Positions panel)." : maxBuy <= 0 ? "Insufficient cash." : ""}
              actionLabel="Buy"
              action="primary"
              onAction={() => onBuy(buyQty)}
            />
            <TradeSide
              label={pos?.kind === "short" ? "Short more" : "Short"}
              qty={shortQty}
              setQty={setShortQty}
              max={maxShort}
              costLabel={maxShort <= 0 ? (hasLong ? "Sell the long first" : "Underlying book empty") : `+Ç${Math.round(shortProceeds).toLocaleString()} · max ${maxShort.toLocaleString()}`}
              disabled={!docked || maxShort <= 0}
              disabledReason={!access.ok ? access.reason : hasLong ? "Sell the long first (in the Positions panel)." : maxShort <= 0 ? `${eq.ticker}'s book is too thin.` : ""}
              actionLabel="Short"
              action="warning"
              onAction={() => onShort(shortQty)}
            />
          </div>

          {!docked && <div className="stocks-warning dim">Equity trades only execute while docked.</div>}
          {eq.lastDividend && (
            <div className="stocks-info-note">
              Last dividend paid at tick {eq.lastDividend.tick.toLocaleString()}.
            </div>
          )}
        </div>

        <LimitOrderPanel equity={eq} world={world} docked={docked} access={access} />
      </div>
    </div>
  );
}

function EquityInfoHeader({ row, world, access }: { row: EquityRow; world: World; access: { ok: boolean; label: string } }) {
  const eq = row.equity;
  const loc = eq.kind === "station" ? world.locations[eq.underlyingId] : null;
  const synd = eq.kind === "syndicate" ? world.syndicates[eq.underlyingId] : null;
  const good = eq.kind === "commodity" ? world.goods[eq.underlyingId] : null;
  const kind = loc ? stationKind(loc) : null;
  const subtype = loc && kind ? stationSubtype(loc, kind) : null;
  const scale = loc && kind ? stationScale(loc, kind) : null;

  let eyebrow = "Listed company";
  if (eq.kind === "station") eyebrow = "Listed station";
  else if (eq.kind === "commodity") eyebrow = "Listed commodity";
  else if (eq.kind === "basis") eyebrow = "Listed basis pair";
  else if (eq.kind === "futures") eyebrow = "Listed futures contract";
  else if (eq.kind === "index") eyebrow = "Listed index";

  let pillLabel = "Syndicate";
  let pillClass = "stocks-kind-syndicate";
  if (loc && kind) {
    pillLabel = stationKindLabel(kind);
    pillClass = `station-kind-${kind}`;
  } else if (eq.kind === "commodity") {
    pillLabel = "Commodity";
    pillClass = "stocks-kind-commodity";
  } else if (eq.kind === "basis") {
    pillLabel = "Basis";
    pillClass = "stocks-kind-basis";
  } else if (eq.kind === "futures") {
    pillLabel = "Futures";
    pillClass = "stocks-kind-futures";
  } else if (eq.kind === "index") {
    pillLabel = "Index";
    pillClass = "stocks-kind-index";
  }

  return (
    <>
      <header className="stocks-info-head">
        <div className="stocks-info-title">
          <span className="stocks-info-eyebrow">{eyebrow}</span>
          <span className="stocks-info-name">{eq.name}</span>
        </div>
        <span className={`station-kind-pill ${pillClass}`}>
          {pillLabel}
        </span>
      </header>

      <div className="stocks-info-meta">
        <span>{eq.ticker}</span>
        <span>{access.ok ? "reachable" : "out of range"}</span>
        {loc?.traits.faction && <span>{loc.traits.faction}</span>}
        {subtype && <span>{stationSubtypeLabel(subtype)}</span>}
        {scale && <span>{stationScaleLabel(scale)}</span>}
        {synd && <span>{synd.memberShipIds.length} ships</span>}
        {good && <span>{good.category}</span>}
      </div>
    </>
  );
}

function CompanyUnderlying({ eq, world }: { eq: Equity; world: World }) {
  if (eq.kind === "station") {
    const market = world.markets[eq.underlyingId];
    const loc = world.locations[eq.underlyingId];
    if (!market || !loc) return null;
    const ntMult = stationNetTradeMultiplier(world, eq);
    const ntPct = (ntMult - 1) * 100;
    return (
      <section className="trade-helper-section">
        <div className="exchange-section-title">Underlying</div>
        <dl className="trade-helper-grid station-info-grid">
          <FleetStat label="treasury" value={`Ç${fmtBig(market.treasury)}`} />
          <FleetStat label="target" value={`Ç${fmtBig(market.treasuryTarget)}`} />
          <FleetStat label="population" value={loc.population.toLocaleString()} />
          <FleetStat label="tech" value={`L${loc.traits.techLevel}`} />
          <FleetStat label="net trade" value={`${ntPct >= 0 ? "+" : ""}${ntPct.toFixed(1)}%`} />
        </dl>
      </section>
    );
  }
  if (eq.kind === "commodity") {
    const good = world.goods[eq.underlyingId];
    if (!good) return null;
    let totalStock = 0;
    let weightedSpot = 0;
    for (const m of Object.values(world.markets)) {
      const stock = m.stock[good.id] ?? 0;
      const price = m.prices[good.id];
      if (price == null || stock <= 0) continue;
      totalStock += stock;
      weightedSpot += stock * price;
    }
    const spot = totalStock > 0 ? weightedSpot / totalStock : good.basePrice;
    return (
      <section className="trade-helper-section">
        <div className="exchange-section-title">Underlying</div>
        <dl className="trade-helper-grid station-info-grid">
          <FleetStat label="category" value={good.category} />
          <FleetStat label="base price" value={`Ç${good.basePrice.toFixed(2)}`} />
          <FleetStat label="spot index" value={`Ç${spot.toFixed(2)}`} />
          <FleetStat label="universe stock" value={fmtBig(totalStock)} />
        </dl>
      </section>
    );
  }
  if (eq.kind === "index") {
    // C-6: index card. Sector indices show member commodities + their
    // current spot. Treasury Index Note (TIN) shows aggregate health.
    const isTin = eq.id === "eq_idx_tin";
    if (isTin) {
      const markets = Object.values(world.markets);
      let healthy = 0, total = 0, sumRatio = 0;
      for (const m of markets) {
        if (m.treasuryTarget <= 0) continue;
        total++;
        sumRatio += m.treasury / m.treasuryTarget;
        if (m.treasury >= m.treasuryTarget) healthy++;
      }
      const avg = total > 0 ? sumRatio / total : 1;
      return (
        <section className="trade-helper-section">
          <div className="exchange-section-title">Underlying</div>
          <dl className="trade-helper-grid station-info-grid">
            <FleetStat label="stations" value={total.toLocaleString()} />
            <FleetStat label="healthy (≥target)" value={`${healthy}/${total}`} />
            <FleetStat label="avg health" value={`${(avg * 100).toFixed(0)}%`} />
          </dl>
        </section>
      );
    }
    // Sector index — list members + their commodity equity prices.
    const def = listSectorIndices().find(s => s.id === eq.id);
    if (!def) return null;
    return (
      <section className="trade-helper-section">
        <div className="exchange-section-title">Underlying — sector basket</div>
        <dl className="trade-helper-grid station-info-grid">
          {def.members.map(m => {
            const mEq = world.equities[`eq_com_${m.goodId}`];
            const good = world.goods[m.goodId];
            return (
              <FleetStat
                key={m.goodId}
                label={good?.name ?? m.goodId}
                value={mEq ? `Ç${mEq.price.toFixed(2)}` : "—"}
              />
            );
          })}
        </dl>
      </section>
    );
  }
  if (eq.kind === "futures") {
    const c = world.contracts?.[eq.id];
    const good = c ? world.goods[c.goodId] : null;
    if (!c || !good) return null;
    const ttx = Math.max(0, c.expiryTick - world.tick);
    const spot = world.equities[c.underlyingEquityId]?.price ?? eq.price;
    const notional = c.contractSize * spot;
    const margin = notional * c.marginFraction;
    return (
      <section className="trade-helper-section">
        <div className="exchange-section-title">Underlying</div>
        <dl className="trade-helper-grid station-info-grid">
          <FleetStat label="good" value={good.name} />
          <FleetStat label="contract size" value={`${c.contractSize}`} />
          <FleetStat label="expires in" value={`${ttx} ticks`} />
          <FleetStat label="spot" value={`Ç${spot.toFixed(2)}`} />
          <FleetStat label="notional" value={`Ç${fmtBig(notional)}`} />
          <FleetStat label="margin (10%)" value={`Ç${fmtBig(margin)}`} />
          <FleetStat label="open interest" value={fmtBig(c.openInterest)} />
        </dl>
      </section>
    );
  }
  if (eq.kind === "basis") {
    const parts = parseBasisUnderlying(eq.underlyingId);
    if (!parts) return null;
    const loc = world.locations[parts.locationId];
    const good = world.goods[parts.goodId];
    const market = world.markets[parts.locationId];
    if (!loc || !good || !market) return null;
    const local = market.prices[good.id] ?? good.basePrice;
    const stock = market.stock[good.id] ?? 0;
    const spread = basisSpreadVsSpot(world, eq);
    const spreadPct = local > 0 ? (spread / local) * 100 : 0;
    return (
      <section className="trade-helper-section">
        <div className="exchange-section-title">Underlying</div>
        <dl className="trade-helper-grid station-info-grid">
          <FleetStat label="station" value={loc.name} />
          <FleetStat label="good" value={good.name} />
          <FleetStat label="local price" value={`Ç${local.toFixed(2)}`} />
          <FleetStat label="vs spot" value={`${spread >= 0 ? "+" : ""}${spread.toFixed(2)} (${spreadPct.toFixed(1)}%)`} />
          <FleetStat label="local stock" value={fmtBig(stock)} />
        </dl>
      </section>
    );
  }
  const synd = world.syndicates[eq.underlyingId];
  if (!synd) return null;
  const memberWealth = synd.memberShipIds.reduce((s, id) => s + (world.traders[id]?.funds ?? 0), 0);
  const lead = synd.memberShipIds.map(id => world.traders[id]).find(Boolean);
  return (
    <section className="trade-helper-section">
      <div className="exchange-section-title">Underlying</div>
      <dl className="trade-helper-grid station-info-grid">
        <FleetStat label="ships" value={synd.memberShipIds.length.toLocaleString()} />
        <FleetStat label="member wealth" value={`Ç${fmtBig(memberWealth)}`} />
        <FleetStat label="treasury" value={`Ç${fmtBig(synd.treasury)}`} />
        <FleetStat label="recent revenue" value={`Ç${fmtBig(synd.recentRevenue)}`} />
        <FleetStat label="lead ship" value={lead?.name ?? "Unassigned"} />
      </dl>
    </section>
  );
}

function InfoStat({ label, value, tone = "" }: { label: string; value: string; tone?: "good" | "bad" | "" }) {
  return (
    <div className="stocks-info-stat">
      <dt>{label}</dt>
      <dd className={`mono ${tone}`}>{value}</dd>
    </div>
  );
}

// --- shared bits -----------------------------------------------------------

interface TradeSideProps {
  label: string;
  qty: number;
  setQty: (q: number) => void;
  max: number;
  costLabel: string;
  disabled: boolean;
  disabledReason: string;
  actionLabel: string;
  action: "primary" | "secondary" | "warning";
  onAction: () => void;
}

function TradeSide({ label, qty, setQty, max, costLabel, disabled, disabledReason, actionLabel, action, onAction }: TradeSideProps) {
  return (
    <div className={`stocks-trade-side action-${action}`}>
      <div className="stocks-trade-label">{label}</div>
      <input
        type="number"
        min={1}
        max={max > 0 ? max : undefined}
        value={qty}
        onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
        disabled={disabled}
      />
      <div className="stocks-trade-cost mono dim">{costLabel}</div>
      <div className="stocks-trade-actions">
        <button onClick={() => setQty(Math.max(1, Math.min(max, 10)))} disabled={disabled || max <= 0}>10</button>
        <button onClick={() => setQty(Math.max(1, Math.min(max, 100)))} disabled={disabled || max <= 0}>100</button>
        <button onClick={() => setQty(Math.max(1, max))} disabled={disabled || max <= 0}>max</button>
      </div>
      <button
        className={`btn-${action}`}
        onClick={onAction}
        disabled={disabled || qty <= 0 || qty > max}
        title={disabled ? disabledReason : ""}
      >
        {actionLabel} {qty}
      </button>
    </div>
  );
}

interface PositionsPanelProps {
  positions: StockPosition[];
  world: World;
  shipId?: string;
  focusedId: string | null;
  cash: number;
  docked: boolean;
  onSelect: (eqId: string) => void;
  onSell: (eqId: string, qty: number) => void;
  onCover: (eqId: string, qty: number) => void;
  onAbandon: (eqId: string) => void;
  onSetStopLoss: (eqId: string, price: number | null) => void;
  onSetTakeProfit: (eqId: string, price: number | null) => void;
}

export function PositionsPanel({ positions, world, shipId, focusedId, cash, docked, onSelect, onSell, onCover, onAbandon, onSetStopLoss, onSetTakeProfit }: PositionsPanelProps) {
  if (positions.length === 0) {
    return <div className="stocks-detail-empty dim">No open positions.</div>;
  }
  const focused = focusedId ? positions.find(p => p.equityId === focusedId) ?? null : null;
  const list = focused ? [focused] : positions;
  return (
    <div className="stocks-positions-list" data-scroll-key="exchange:pno:positions:table">
      <SortableRows
        rows={list}
        columns={[
          { id: "ticker", label: "ticker", getValue: pos => world.equities[pos.equityId]?.ticker ?? pos.equityId },
          { id: "side", label: "side", getValue: pos => pos.kind },
          { id: "shares", label: "shares", getValue: pos => pos.shares, defaultDirection: "desc" },
          { id: "entry", label: "entry", getValue: pos => pos.avgEntryPrice, defaultDirection: "desc" },
          { id: "mark", label: "mark", getValue: pos => world.equities[pos.equityId]?.price ?? null, defaultDirection: "desc" },
          { id: "pnl", label: "profit/loss", getValue: pos => unrealizedPnl(world, pos), defaultDirection: "desc" },
          { id: "stop", label: "stop", getValue: pos => pos.stopLoss ?? null },
          { id: "take", label: "take", getValue: pos => pos.takeProfit ?? null, defaultDirection: "desc" },
        ]}
      >
        {(sortedPositions, sort) => (
          <table className="stocks-positions-table">
            <thead>
              <tr>
                <SortableTh sort={sort} columnId="ticker">Ticker</SortableTh>
                <SortableTh sort={sort} columnId="side">Side</SortableTh>
                <SortableTh sort={sort} columnId="shares">Shares</SortableTh>
                <SortableTh sort={sort} columnId="entry">Entry</SortableTh>
                <SortableTh sort={sort} columnId="mark">Mark</SortableTh>
                <SortableTh sort={sort} columnId="pnl">P&amp;L</SortableTh>
                <SortableTh sort={sort} columnId="stop">Stop</SortableTh>
                <SortableTh sort={sort} columnId="take">Take</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sortedPositions.map(pos => {
                const eq = world.equities[pos.equityId];
                if (!eq) return null;
                const pnl = unrealizedPnl(world, pos);
                const cls = pnl > 0 ? "stock-pnl-up" : pnl < 0 ? "stock-pnl-down" : "";
                const isFocused = focused?.equityId === pos.equityId;
                const access = exchangeAccess(world, eq, shipId);
                return (
                  <PositionRowFragment
                    key={pos.equityId}
                    pos={pos}
                    eq={eq}
                    pnl={pnl}
                    pnlClass={cls}
                    isFocused={isFocused}
                    cash={cash}
                    docked={docked}
                    accessOk={access.ok}
                    accessReason={access.reason}
                    onSelect={() => onSelect(pos.equityId)}
                    onSell={(qty) => onSell(pos.equityId, qty)}
                    onCover={(qty) => onCover(pos.equityId, qty)}
                    onAbandon={() => onAbandon(pos.equityId)}
                    onSetStopLoss={(price) => onSetStopLoss(pos.equityId, price)}
                    onSetTakeProfit={(price) => onSetTakeProfit(pos.equityId, price)}
                  />
                );
              })}
            </tbody>
          </table>
        )}
      </SortableRows>
    </div>
  );
}

interface PositionRowFragmentProps {
  pos: StockPosition;
  eq: Equity;
  pnl: number;
  pnlClass: string;
  isFocused: boolean;
  cash: number;
  docked: boolean;
  accessOk: boolean;
  accessReason: string;
  onSelect: () => void;
  onSell: (qty: number) => void;
  onCover: (qty: number) => void;
  onAbandon: () => void;
  onSetStopLoss: (price: number | null) => void;
  onSetTakeProfit: (price: number | null) => void;
}

function PositionRowFragment({ pos, eq, pnl, pnlClass, isFocused, cash, docked, accessOk, accessReason, onSelect, onSell, onCover, onAbandon, onSetStopLoss, onSetTakeProfit }: PositionRowFragmentProps) {
  const isLong = pos.kind === "long";
  const [closeQty, setCloseQty] = useState<number>(Math.min(10, pos.shares));
  const closeProceeds = closeQty * eq.price * (1 - BROKER_FEE_RATE);
  const closeCost = closeQty * eq.price * (1 + BROKER_FEE_RATE);
  const maxCover = Math.max(0, Math.min(
    pos.shares,
    Math.floor(cash / Math.max(0.0001, eq.price * (1 + BROKER_FEE_RATE))),
  ));

  return (
    <>
      <tr className={isFocused ? "focused" : ""} onClick={onSelect}>
        <td><span className="ticker mono">{eq.ticker}</span></td>
        <td><span className={`pos-tag ${pos.kind}`}>{isLong ? "LONG" : "SHORT"}</span></td>
        <td className="mono">{pos.shares.toLocaleString()}</td>
        <td className="mono dim">Ç{fmtPrice(pos.avgEntryPrice)}</td>
        <td className="mono">Ç{fmtPrice(eq.price)}</td>
        <td className={`mono ${pnlClass}`}>{pnl >= 0 ? "+" : ""}Ç{Math.round(pnl).toLocaleString()}</td>
        <td className="mono dim">{pos.stopLoss != null ? `Ç${fmtPrice(pos.stopLoss)}` : "—"}</td>
        <td className="mono dim">{pos.takeProfit != null ? `Ç${fmtPrice(pos.takeProfit)}` : "—"}</td>
      </tr>
      {isFocused && (
        <tr className="position-controls-row">
          <td colSpan={8}>
            <div className="position-controls-grid">
              <RiskLevels
                position={pos}
                currentPrice={eq.price}
                onSetStopLoss={onSetStopLoss}
                onSetTakeProfit={onSetTakeProfit}
              />
              <div className="position-close-side">
                {isLong ? (
                  <TradeSide
                    label="Sell"
                    qty={closeQty}
                    setQty={setCloseQty}
                    max={pos.shares}
                    costLabel={`+Ç${Math.round(closeProceeds).toLocaleString()} after fee`}
                    disabled={!docked || !accessOk}
                    disabledReason={!docked ? "Dock first." : !accessOk ? accessReason : ""}
                    actionLabel="Sell"
                    action="secondary"
                    onAction={() => onSell(closeQty)}
                  />
                ) : (
                  <TradeSide
                    label="Cover"
                    qty={closeQty}
                    setQty={setCloseQty}
                    max={maxCover}
                    costLabel={maxCover <= 0 ? "Need cash for at least one share" : `Ç${Math.round(closeCost).toLocaleString()} · max ${maxCover.toLocaleString()}`}
                    disabled={!docked || !accessOk || maxCover <= 0}
                    disabledReason={!docked ? "Dock first." : !accessOk ? accessReason : maxCover <= 0 ? "Need cash to cover." : ""}
                    actionLabel="Cover"
                    action="secondary"
                    onAction={() => onCover(closeQty)}
                  />
                )}
                <button
                  className="btn-abandon abandon-full"
                  onClick={onAbandon}
                  disabled={!docked}
                  title={docked ? "Walk away from this position with a 5% penalty." : "Dock first."}
                >
                  Abandon position
                </button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// C-3 / C-4: open futures positions accordion. Mirrors PositionsAccordion's
// look — same header grid (ticker, side pill, contracts, mark, P&L) and
// expand-to-show-details body. Expanded body has margin posted, expiry
// countdown, delivery station, physical-ready indicator, and a Close
// button.
function FuturesPositionsList({ world, futures, docked, activeHint, onSelectEquity }: {
  world: World;
  futures: FuturesPosition[];
  docked: boolean;
  activeHint: StockExchangeHint | null;
  onSelectEquity: (eqId: string) => void;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  if (futures.length === 0) {
    return <div className="stocks-pno-empty dim">No open futures.</div>;
  }
  return (
    <SortableRows
      rows={futures}
      columns={[
        { id: "ticker", label: "ticker", getValue: fp => world.equities[fp.contractId]?.ticker ?? fp.contractId },
        { id: "side", label: "side", getValue: fp => fp.side },
        { id: "contracts", label: "contracts", getValue: fp => fp.contracts, defaultDirection: "desc" },
        {
          id: "mark",
          label: "mark",
          getValue: fp => {
            const c = world.contracts?.[fp.contractId];
            return c ? world.equities[c.underlyingEquityId]?.price ?? world.equities[fp.contractId]?.price ?? null : null;
          },
          defaultDirection: "desc",
        },
        { id: "pnl", label: "profit/loss", getValue: fp => unrealizedFuturesPnl(world, fp), defaultDirection: "desc" },
      ]}
    >
      {(sortedFutures, sort) => (
        <div className="stocks-pno-list" data-scroll-key="exchange:pno:futures:list">
          <div className="stocks-pno-header positions">
            <SortableHeaderButton sort={sort} columnId="ticker">Ticker</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="side">Side</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="contracts" className="numeric">Contracts</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="mark" className="numeric">Mark</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="pnl" className="numeric">P&amp;L</SortableHeaderButton>
          </div>
          {sortedFutures.map(fp => {
            const c = world.contracts?.[fp.contractId];
            const eq = world.equities[fp.contractId];
            if (!c || !eq) return null;
            const isOpen = expandedId === fp.contractId;
            return (
              <FuturesAccordionItem
                key={fp.contractId}
                world={world}
                equity={eq}
                contract={c}
                position={fp}
                docked={docked}
                activeHint={activeHint}
                isOpen={isOpen}
                onToggle={() => {
                  setExpandedId(isOpen ? null : fp.contractId);
                  onSelectEquity(fp.contractId);
                }}
              />
            );
          })}
        </div>
      )}
    </SortableRows>
  );
}

function FuturesAccordionItem({ world, equity, contract, position, docked, activeHint, isOpen, onToggle }: {
  world: World;
  equity: Equity;
  contract: FuturesContract;
  position: FuturesPosition;
  docked: boolean;
  activeHint: StockExchangeHint | null;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const closeFuture = useStore(s => s.closeFuture);
  const spot = world.equities[contract.underlyingEquityId]?.price ?? equity.price;
  const pnl = unrealizedFuturesPnl(world, position);
  const pnlPct = position.avgEntryPrice > 0
    ? (pnl / (position.avgEntryPrice * contract.contractSize * position.contracts)) * 100
    : 0;
  const tone = pnl > 0 ? "good" : pnl < 0 ? "bad" : "";
  const ttx = Math.max(0, contract.expiryTick - world.tick);
  const notional = contract.contractSize * spot * position.contracts;
  const playerShipId = useSelectedPlayerShipId(world);
  const ship = playerShipId ? world.traders[playerShipId] : null;
  const canDeliver = ship ? canDeliverPhysical(world, contract, position, ship) : false;
  const deliveryName = world.locations[contract.deliveryStation]?.name ?? contract.deliveryStation;
  const ageTicks = world.tick - position.openedAt;
  const closeHint = activeHint?.action === "close_future" && activeHint.equityId === equity.id ? activeHint : null;

  return (
    <div className={`stocks-accordion-item ${isOpen ? "open" : ""} ${position.side}`}>
      <button type="button" className="stocks-accordion-summary" onClick={onToggle}>
        <StockGuidanceCell
          guided={!!closeHint && !isOpen}
          hintText={`Open ${equity.ticker}'s futures controls.`}
        >
          <span className="ticker mono">{equity.ticker}</span>
        </StockGuidanceCell>
        <span className="kind-pill mono">{position.side === "long" ? "LONG" : "SHORT"}</span>
        <span className="numeric mono">{position.contracts} ct</span>
        <span className="numeric mono dim">Ç{fmtPrice(spot)}</span>
        <span className={`numeric mono pnl ${tone}`}>
          {pnl >= 0 ? "+" : ""}Ç{Math.round(pnl).toLocaleString()}
          <span className="dim"> ({pnl >= 0 ? "+" : ""}{pnlPct.toFixed(1)}%)</span>
        </span>
      </button>
      {isOpen && (
        <div className="stocks-accordion-body">
          <dl className="trade-helper-grid station-info-grid">
            <FleetStat label="mark" value={`Ç${fmtPrice(spot)}`} />
            <FleetStat label="entry" value={`Ç${fmtPrice(position.avgEntryPrice)}`} />
            <FleetStat label="contract size" value={`${contract.contractSize}`} />
            <FleetStat label="notional" value={`Ç${Math.round(notional).toLocaleString()}`} />
            <FleetStat label="margin" value={`Ç${Math.round(position.marginPosted).toLocaleString()}`} />
            <FleetStat label="P&L" value={`${pnl >= 0 ? "+" : ""}Ç${Math.round(pnl).toLocaleString()}`} />
            <FleetStat label="expires in" value={`${ttx}t`} />
            <FleetStat label="held for" value={`${ageTicks}t`} />
            <FleetStat label="delivery" value={deliveryName} />
          </dl>

          {position.side === "short" && (
            <div className={`stocks-warning ${canDeliver ? "good" : "dim"}`} style={{ marginTop: 8 }}>
              {canDeliver
                ? `Physical delivery ready — at ${deliveryName} with ${contract.contractSize * position.contracts} ${world.goods[contract.goodId]?.name ?? contract.goodId} on hand. Settles at strike on expiry.`
                : `Physical delivery requires ${contract.contractSize * position.contracts} ${world.goods[contract.goodId]?.name ?? contract.goodId} cargo at ${deliveryName} when the contract expires.`}
            </div>
          )}

          <section className="trade-helper-section">
            <div className="stocks-position-row close">
              <StockGuidanceCell
                guided={!!closeHint && isOpen && closeHint.executable && docked && position.contracts > 0}
                hintText={closeHint ? `Execute ${closeHint.actionLabel.toLowerCase()}.` : ""}
                onPingClick={() => closeFuture(position.contractId)}
              >
                <button
                  className="btn-action primary"
                  disabled={!docked || position.contracts <= 0}
                  onClick={() => closeFuture(position.contractId)}
                >
                  Close all ({position.contracts})
                </button>
              </StockGuidanceCell>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

const TRADES_PAGE_SIZE = 100;

function TradesList({ trades, onSelect }: { trades: TradeRecord[]; onSelect: (eqId: string) => void }) {
  const gameId = useStore(s => s.world.gameId);
  // Older trades pulled from IndexedDB beyond the in-memory ledger window
  // (capped at ~200 in memory by post-flush trim). Each scroll-to-end fetch
  // pulls another TRADES_PAGE_SIZE older entries.
  const [olderTrades, setOlderTrades] = useState<TradeRecord[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const fetchingRef = useRef(false);
  const sentinelRef = useRef<HTMLTableRowElement | null>(null);

  // Reset on game change.
  useEffect(() => {
    setOlderTrades([]);
    setExhausted(false);
    fetchingRef.current = false;
  }, [gameId]);

  // Combine in-memory + IDB-backfilled (both newest-first within their
  // range; older block follows the newer block).
  const allTrades = olderTrades.length > 0 ? [...trades, ...olderTrades] : trades;

  useEffect(() => {
    if (exhausted) return;
    const sentinel = sentinelRef.current;
    if (!sentinel || !gameId) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || fetchingRef.current) return;
      const earliestTick = allTrades[allTrades.length - 1]?.tick;
      if (earliestTick == null) return;
      fetchingRef.current = true;
      void getTradeRecordsBefore(gameId, earliestTick, TRADES_PAGE_SIZE)
        .then(records => {
          fetchingRef.current = false;
          if (records.length === 0) {
            setExhausted(true);
            return;
          }
          const cleaned: TradeRecord[] = records.map(r => {
            const out: TradeRecord = {
              id: r.id, tick: r.tick, equityId: r.equityId, ticker: r.ticker,
              action: r.action, shares: r.shares, price: r.price, fee: r.fee,
              cashFlow: r.cashFlow,
            };
            if (r.realizedPnl !== undefined) out.realizedPnl = r.realizedPnl;
            if (r.trigger !== undefined) out.trigger = r.trigger;
            return out;
          });
          setOlderTrades(prev => [...prev, ...cleaned]);
        })
        .catch(err => {
          fetchingRef.current = false;
          console.warn("[logics] trade ledger backfill failed", err);
        });
    }, { rootMargin: "200px" });
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [allTrades, exhausted, gameId]);

  if (allTrades.length === 0) {
    return <div className="stocks-detail-empty dim">No trades yet.</div>;
  }
  return (
    <div className="stocks-trades-list" data-scroll-key="exchange:pno:history:list">
      <SortableRows
        rows={allTrades}
        columns={[
          { id: "tick", label: "tick", getValue: trade => trade.tick, defaultDirection: "desc" },
          { id: "action", label: "action", getValue: trade => trade.action },
          { id: "ticker", label: "ticker", getValue: trade => trade.ticker },
          { id: "qty", label: "quantity", getValue: trade => trade.shares, defaultDirection: "desc" },
          { id: "price", label: "price", getValue: trade => trade.price, defaultDirection: "desc" },
          { id: "cash", label: "cash", getValue: trade => trade.cashFlow, defaultDirection: "desc" },
          { id: "pnl", label: "profit/loss", getValue: trade => trade.realizedPnl ?? null, defaultDirection: "desc" },
        ]}
      >
        {(sortedTrades, sort) => (
          <table className="stocks-trades-table">
            <thead>
              <tr>
                <SortableTh sort={sort} columnId="tick">Tick</SortableTh>
                <SortableTh sort={sort} columnId="action">Action</SortableTh>
                <SortableTh sort={sort} columnId="ticker">Ticker</SortableTh>
                <SortableTh sort={sort} columnId="qty">Qty</SortableTh>
                <SortableTh sort={sort} columnId="price">Price</SortableTh>
                <SortableTh sort={sort} columnId="cash">Cash</SortableTh>
                <SortableTh sort={sort} columnId="pnl">P&amp;L</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sortedTrades.map(tr => {
                const cls = (tr.realizedPnl ?? 0) > 0 ? "stock-pnl-up" : (tr.realizedPnl ?? 0) < 0 ? "stock-pnl-down" : "";
                return (
                  <tr key={tr.id} onClick={() => onSelect(tr.equityId)}>
                    <td className="mono dim">{tr.tick.toLocaleString()}</td>
                    <td><ActionTag action={tr.action} trigger={tr.trigger} /></td>
                    <td><span className="ticker mono">{tr.ticker}</span></td>
                    <td className="mono">{tr.shares.toLocaleString()}</td>
                    <td className="mono dim">Ç{fmtPrice(tr.price)}</td>
                    <td className={`mono ${tr.cashFlow >= 0 ? "stock-pnl-up" : ""}`}>
                      {tr.cashFlow >= 0 ? "+" : ""}Ç{Math.round(tr.cashFlow).toLocaleString()}
                    </td>
                    <td className={`mono ${cls}`}>
                      {tr.realizedPnl != null ? (
                        `${tr.realizedPnl >= 0 ? "+" : ""}Ç${Math.round(tr.realizedPnl).toLocaleString()}`
                      ) : <span className="dim">—</span>}
                    </td>
                  </tr>
                );
              })}
              {!exhausted && (
                <tr ref={sentinelRef} className="stocks-trades-sentinel">
                  <td colSpan={7} className="dim">Loading older trades…</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </SortableRows>
    </div>
  );
}

function InsightsList({ hints, activeHint, onSelect, emptyText }: {
  hints: StockExchangeHint[];
  activeHint: StockExchangeHint | null;
  onSelect: (eqId: string) => void;
  emptyText: string;
}) {
  if (hints.length === 0) {
    return <div className="stocks-detail-empty dim">{emptyText}</div>;
  }
  return (
    <div className="stocks-insights-list" data-scroll-key="exchange:pno:insights:list">
      <SortableRows
        rows={hints}
        columns={[
          { id: "score", label: "score", getValue: hint => hint.score, defaultDirection: "desc" },
          { id: "signal", label: "signal", getValue: hint => `${hint.action}:${hint.ticker}` },
          { id: "edge", label: "edge", getValue: hint => hint.edgePct, defaultDirection: "desc" },
          { id: "limit", label: "limit", getValue: hint => hint.suggestedLimitPrice ?? null, defaultDirection: "desc" },
          { id: "status", label: "status", getValue: hint => hint.executable ? 1 : 0, defaultDirection: "desc" },
          { id: "reason", label: "reason", getValue: hint => hint.reason },
        ]}
      >
        {(sortedHints, sort) => (
          <table className="stocks-insights-table">
            <thead>
              <tr>
                <SortableTh sort={sort} columnId="score">Score</SortableTh>
                <SortableTh sort={sort} columnId="signal">Signal</SortableTh>
                <SortableTh sort={sort} columnId="edge">Edge</SortableTh>
                <SortableTh sort={sort} columnId="limit">Limit</SortableTh>
                <SortableTh sort={sort} columnId="status">Status</SortableTh>
                <SortableTh sort={sort} columnId="reason">Reason</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sortedHints.map(hint => {
                const guided = activeHint?.equityId === hint.equityId && activeHint.action === hint.action;
                return (
                  <tr
                    key={`${hint.equityId}:${hint.action}`}
                    className={`${guided ? "guided" : ""} ${hint.executable ? "ready" : "blocked"}`}
                    onClick={() => onSelect(hint.equityId)}
                    title={hint.executable ? hint.reason : hint.blockReason ?? hint.reason}
                  >
                    <td className="mono dim">{hint.score.toFixed(2)}</td>
                    <td><span className={`stocks-hint-chin-action ${hint.action}`}>{compactHintActionLabel(hint)}</span></td>
                    <td className={`mono ${hint.edgePct >= 0 ? "stock-pnl-up" : "stock-pnl-down"}`}>{fmtPct(hint.edgePct)}</td>
                    <td className="mono dim">{hint.suggestedLimitPrice != null ? `Ç${fmtPrice(hint.suggestedLimitPrice)}` : "—"}</td>
                    <td className={`stocks-insight-status ${hint.executable ? "ready" : "blocked"}`}>
                      {hint.executable ? "Ready" : "Blocked"}
                    </td>
                    <td className="stocks-insight-reason">
                      {hint.executable ? hint.reason : hint.blockReason ?? hint.reason}
                    </td>
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

interface RiskLevelsProps {
  position: StockPosition;
  currentPrice: number;
  onSetStopLoss: (price: number | null) => void;
  onSetTakeProfit: (price: number | null) => void;
}

function RiskLevels({ position, currentPrice, onSetStopLoss, onSetTakeProfit }: RiskLevelsProps) {
  const isLong = position.kind === "long";
  // Quick-fill chips: stop chips are adverse (below entry for long, above
  // for short); take chips are favorable (the opposite). We anchor against
  // the avg entry price — that's the well-defined reference point.
  const stopChips = [0.02, 0.05, 0.10];
  const takeChips = [0.05, 0.10, 0.20];
  const stopPriceFor = (pct: number) => isLong ? position.avgEntryPrice * (1 - pct) : position.avgEntryPrice * (1 + pct);
  const takePriceFor = (pct: number) => isLong ? position.avgEntryPrice * (1 + pct) : position.avgEntryPrice * (1 - pct);

  const defaultStop = stopPriceFor(0.05);
  const defaultTake = takePriceFor(0.10);

  const [stopText, setStopText] = useState<string>(() => position.stopLoss != null ? position.stopLoss.toFixed(2) : "");
  const [takeText, setTakeText] = useState<string>(() => position.takeProfit != null ? position.takeProfit.toFixed(2) : "");

  useEffect(() => {
    setStopText(position.stopLoss != null ? position.stopLoss.toFixed(2) : "");
    setTakeText(position.takeProfit != null ? position.takeProfit.toFixed(2) : "");
  }, [position.equityId, position.stopLoss, position.takeProfit]);

  const apply = (text: string, setter: (price: number | null) => void) => {
    const trimmed = text.trim();
    if (trimmed === "") { setter(null); return; }
    const n = Number(trimmed);
    if (Number.isFinite(n) && n > 0) setter(n);
  };

  const setStop = (price: number) => {
    setStopText(price.toFixed(2));
    onSetStopLoss(price);
  };
  const setTake = (price: number) => {
    setTakeText(price.toFixed(2));
    onSetTakeProfit(price);
  };

  const stopPctVsMark = position.stopLoss != null && currentPrice > 0
    ? ((position.stopLoss - currentPrice) / currentPrice) * 100
    : null;
  const takePctVsMark = position.takeProfit != null && currentPrice > 0
    ? ((position.takeProfit - currentPrice) / currentPrice) * 100
    : null;

  return (
    <div className="stocks-risk-levels">
      <div className="stocks-section-title">Risk levels</div>
      <div className="stocks-risk-grid">
        <div className="stocks-risk-side">
          <label className="stocks-risk-label">
            Stop-loss
            <span className="dim mono">{isLong ? "auto-sells if price ≤" : "auto-covers if price ≥"}</span>
          </label>
          <div className="stocks-risk-input-row">
            <input
              type="number" step="any" placeholder={`e.g. ${defaultStop.toFixed(2)}`}
              value={stopText}
              onChange={(e) => setStopText(e.target.value)}
              onBlur={() => apply(stopText, onSetStopLoss)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
            />
            <button className="risk-clear" onClick={() => { setStopText(""); onSetStopLoss(null); }} disabled={position.stopLoss == null}>×</button>
          </div>
          <div className="stocks-risk-chips">
            {stopChips.map(pct => (
              <button key={pct} onClick={() => setStop(stopPriceFor(pct))} title={`Ç${stopPriceFor(pct).toFixed(2)} (${(pct * 100).toFixed(0)}% adverse from entry)`}>
                {(pct * 100).toFixed(0)}%
              </button>
            ))}
          </div>
          {stopPctVsMark != null && <span className="dim mono">{stopPctVsMark >= 0 ? "+" : ""}{stopPctVsMark.toFixed(1)}% vs mark</span>}
        </div>
        <div className="stocks-risk-side">
          <label className="stocks-risk-label">
            Take-profit
            <span className="dim mono">{isLong ? "auto-sells if price ≥" : "auto-covers if price ≤"}</span>
          </label>
          <div className="stocks-risk-input-row">
            <input
              type="number" step="any" placeholder={`e.g. ${defaultTake.toFixed(2)}`}
              value={takeText}
              onChange={(e) => setTakeText(e.target.value)}
              onBlur={() => apply(takeText, onSetTakeProfit)}
              onKeyDown={(e) => { if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur(); }}
            />
            <button className="risk-clear" onClick={() => { setTakeText(""); onSetTakeProfit(null); }} disabled={position.takeProfit == null}>×</button>
          </div>
          <div className="stocks-risk-chips">
            {takeChips.map(pct => (
              <button key={pct} onClick={() => setTake(takePriceFor(pct))} title={`Ç${takePriceFor(pct).toFixed(2)} (${(pct * 100).toFixed(0)}% favorable from entry)`}>
                {(pct * 100).toFixed(0)}%
              </button>
            ))}
          </div>
          {takePctVsMark != null && <span className="dim mono">{takePctVsMark >= 0 ? "+" : ""}{takePctVsMark.toFixed(1)}% vs mark</span>}
        </div>
      </div>
    </div>
  );
}

function ActionTag({ action, trigger }: { action: TradeRecord["action"]; trigger?: TradeRecord["trigger"] }) {
  const label = {
    open_long: "BUY",
    add_long: "BUY+",
    close_long: "SELL",
    open_short: "SHORT",
    add_short: "SHORT+",
    cover_short: "COVER",
  }[action];
  const cls = action.includes("long") ? "act-long" : "act-short";
  return (
    <span className={`action-tag-wrap`}>
      <span className={`action-tag ${cls}`}>{label}</span>
      {trigger && (
        <span className={`trigger-tag trigger-${trigger}`}>
          {trigger === "stop_loss" ? "STOP" : "TAKE"}
        </span>
      )}
    </span>
  );
}

function ChangeCell({ pct, big = false }: { pct: number; big?: boolean }) {
  const formatted = `${pct >= 0 ? "+" : ""}${(pct * 100).toFixed(2)}%`;
  const cls = pct > 0.0005 ? "up" : pct < -0.0005 ? "down" : "flat";
  const Icon = pct > 0.0005 ? MdArrowDropUp : pct < -0.0005 ? MdArrowDropDown : MdRemove;
  return (
    <span className={`change ${cls} ${big ? "big" : ""} mono`}>
      <Icon aria-hidden="true" />{formatted}
    </span>
  );
}

function HealthBar({ value, label }: { value: number; label: string }) {
  const clamped = Math.max(0, Math.min(2, value));
  const pct = (clamped / 2) * 100;
  const cls = clamped > 1.2 ? "high" : clamped > 0.8 ? "mid" : clamped > 0.4 ? "low" : "crit";
  return (
    <span className="health-bar" title={label}>
      <span className={`health-fill ${cls}`} style={{ width: `${pct}%` }} />
      <span className="health-label mono dim">{label}</span>
    </span>
  );
}

function normalizeSparklineHistory(history: { tick: number; price: number }[]): { tick: number; price: number }[] {
  const byTick = new Map<number, number>();
  for (const point of history) {
    if (!Number.isFinite(point.tick) || !Number.isFinite(point.price)) continue;
    byTick.set(point.tick, point.price);
  }
  return [...byTick.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tick, price]) => ({ tick, price }));
}

// Two-panel chart powered by lightweight-charts: price area on top +
// volume histogram pinned to the bottom of the same canvas. Position
// reference lines (avg entry, stop-loss, take-profit) ride along the
// price scale via createPriceLine. Tick numbers are mapped to integer
// time units and the time formatter renders them as "T1234" so the chart
// reads as ticks rather than dates.
function Sparkline({ equity, position }: { equity: Equity; position: StockPosition | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  // Bumps when the container first acquires a non-zero width. The chart
  // is created at mount-time, sometimes when the panel layout hasn't
  // settled and clientWidth = 0 — at that point the initial setData
  // gets accepted but the chart can't render anything against zero
  // pixels. When the width finally becomes real we bump this counter
  // so the data effect re-fires with a fresh full setData.
  const [layoutGen, setLayoutGen] = useState(0);

  // The chart shows the last `historyDepth` price samples; we expand on
  // overpan past the leftmost loaded bar. The ring (equity.history) is
  // capped (post-flush trim in historyDb.ts at 1000) so unbounded growth
  // doesn't pin heap memory.
  const HISTORY_PAGE = 100;
  const TRADES_PAGE = 500;
  const [historyDepth, setHistoryDepth] = useState(HISTORY_PAGE);
  const fetchingRef = useRef<boolean>(false);

  const ringHistory = equity.history ?? [];
  const ringTrades = equity.recentTrades ?? [];
  const historyStart = Math.max(0, ringHistory.length - historyDepth);
  const history = historyStart === 0 ? ringHistory : ringHistory.slice(historyStart);
  const tradesStart = Math.max(0, ringTrades.length - TRADES_PAGE);
  const trades = tradesStart === 0 ? ringTrades : ringTrades.slice(tradesStart);

  // Build the chart once the container has an actual measurable width.
  // On first paint of the Exchange tab the info panel may still be in
  // layout (clientWidth = 0); creating the chart at 0 px causes the
  // initial setData to land on an unrenderable canvas, and even after
  // resize the chart never recovers the data — only later update()
  // calls take effect, so the user sees a 1- or 2-point line. Wait
  // for a non-zero width via requestAnimationFrame poll, then create
  // the chart and bump layoutGen so the data effect runs setData.
  useEffect(() => {
    const div = containerRef.current;
    if (!div) return;

    let cancelled = false;
    let raf: number | null = null;
    let ro: ResizeObserver | null = null;

    const buildChart = () => {
      if (cancelled) return;
      const w = div.clientWidth;
      if (w <= 0) {
        raf = requestAnimationFrame(buildChart);
        return;
      }

      const chart = createChart(div, {
        width: w,
        height: 170,
        autoSize: false,
        layout: {
          background: { type: ColorType.Solid, color: "transparent" },
          textColor: "rgba(220, 230, 240, 0.42)",
          fontSize: 11,
          attributionLogo: false,
        },
        grid: {
          vertLines: { color: "rgba(255,255,255,0.04)" },
          horzLines: { color: "rgba(255,255,255,0.04)" },
        },
        rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
        timeScale: {
          borderColor: "rgba(255,255,255,0.08)",
          tickMarkFormatter: (time: Time) => `T${time}`,
        },
        localization: {
          timeFormatter: (time: Time) => `tick ${time}`,
          priceFormatter: (p: number) => `Ç${p.toFixed(2)}`,
        },
        crosshair: { mode: 1 },
      });
      const price = chart.addSeries(AreaSeries, {
        lineColor: "#6cd99a",
        topColor: "rgba(108,217,154,0.30)",
        bottomColor: "rgba(108,217,154,0.02)",
        lineWidth: 2,
        priceFormat: { type: "price", precision: 2, minMove: 0.01 },
        priceLineVisible: false,
        lastValueVisible: true,
      });
      const volume = chart.addSeries(HistogramSeries, {
        priceFormat: { type: "volume" },
        priceScaleId: "",
        color: "rgba(108,217,154,0.55)",
      });
      volume.priceScale().applyOptions({ scaleMargins: { top: 0.78, bottom: 0 } });

      chartRef.current = chart;
      priceSeriesRef.current = price;
      volumeSeriesRef.current = volume;

      ro = new ResizeObserver(() => {
        if (!chartRef.current) return;
        chartRef.current.applyOptions({ width: div.clientWidth });
        chartRef.current.timeScale().fitContent();
      });
      ro.observe(div);

      // Ready — trigger the data effect to run setData against the now-
      // real-width chart.
      setLayoutGen(g => g + 1);
    };

    buildChart();

    return () => {
      cancelled = true;
      if (raf != null) cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      if (chartRef.current) chartRef.current.remove();
      chartRef.current = null;
      priceSeriesRef.current = null;
      volumeSeriesRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  // Push price + volume data. The sim mutates eq.history in place
  // (Array.push), so we track length + the last price as effect deps.
  // Each tick we append via series.update() so the user's pan/zoom and
  // crosshair position survive — full setData would reset interactions.
  // Full setData happens on equity switch, backward scrub, OR a lazy
  // depth expansion (more older bars now visible).
  const histLen = history.length;
  const tradesLen = trades.length;
  const lastPrice = history.length > 0 ? history[history.length - 1].price : 0;
  const lastTick = history.length > 0 ? history[history.length - 1].tick : -1;
  const lastSeenTickRef = useRef<number>(-1);
  const lastSeenEquityRef = useRef<string>("");
  const lastLayoutGenRef = useRef<number>(0);
  const lastDepthRef = useRef<number>(0);
  useEffect(() => {
    const price = priceSeriesRef.current;
    const volume = volumeSeriesRef.current;
    if (!price || !volume) return;
    const points = normalizeSparklineHistory(history);
    if (points.length < 2) {
      price.setData([]);
      volume.setData([]);
      lastSeenTickRef.current = -1;
      lastSeenEquityRef.current = equity.id;
      lastLayoutGenRef.current = layoutGen;
      lastDepthRef.current = histLen;
      return;
    }

    const equityChanged = lastSeenEquityRef.current !== equity.id;
    const layoutSettled = lastLayoutGenRef.current !== layoutGen;
    // The window grew when histLen jumped beyond what an incremental tick
    // (1 new bar) would explain — i.e., the user scrolled left and we
    // expanded historyDepth.
    const depthExpanded = histLen - lastDepthRef.current > 2 && !equityChanged && !layoutSettled;
    const seen = lastSeenTickRef.current;
    const newest = points[points.length - 1].tick;
    const canAppend = !equityChanged && !layoutSettled && !depthExpanded && seen >= 0 && newest >= seen;

    // Build per-tick volume map once — used by both append and full reset.
    const buyVol: Record<number, number> = {};
    const sellVol: Record<number, number> = {};
    for (const t of trades) {
      if (t.takerSide === "bid") buyVol[t.tick] = (buyVol[t.tick] ?? 0) + t.qty;
      else sellVol[t.tick] = (sellVol[t.tick] ?? 0) + t.qty;
    }
    const volumeBar = (p: { tick: number }) => {
      const buy = buyVol[p.tick] ?? 0;
      const sell = sellVol[p.tick] ?? 0;
      return {
        time: p.tick as UTCTimestamp,
        value: buy + sell,
        color: buy >= sell ? "rgba(108,217,154,0.55)" : "rgba(239,111,125,0.55)",
      };
    };

    if (canAppend) {
      // Update only the points at-or-after the last-seen tick. The
      // series accepts update() with a time matching an existing point
      // (overwrites) or one strictly greater (appends).
      const tail = points.filter(p => p.tick >= seen);
      for (const p of tail) {
        price.update({ time: p.tick as UTCTimestamp, value: p.price });
        volume.update(volumeBar(p));
      }
    } else if (depthExpanded) {
      // User scrolled left near the edge and we expanded the visible
      // window. Capture the current visible logical range, do a full
      // setData, then shift the range right by the number of bars we
      // prepended so the same ticks stay under the user's eye.
      const ts = chartRef.current?.timeScale();
      const prevRange = ts?.getVisibleLogicalRange() ?? null;
      const addedCount = histLen - lastDepthRef.current;
      price.setData(points.map(p => ({ time: p.tick as UTCTimestamp, value: p.price })));
      volume.setData(points.map(volumeBar));
      if (ts && prevRange && addedCount > 0) {
        ts.setVisibleLogicalRange({
          from: prevRange.from + addedCount,
          to: prevRange.to + addedCount,
        });
      }
    } else {
      // Equity switch or backward scrub — full reset and re-fit so the
      // user gets the new ticker centered. Pan/zoom on the new chart
      // is then preserved by future incremental updates.
      price.setData(points.map(p => ({ time: p.tick as UTCTimestamp, value: p.price })));
      volume.setData(points.map(volumeBar));
      chartRef.current?.timeScale().fitContent();
    }
    lastSeenTickRef.current = newest;
    lastSeenEquityRef.current = equity.id;
    lastLayoutGenRef.current = layoutGen;
    lastDepthRef.current = histLen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equity.id, histLen, tradesLen, lastPrice, lastTick, layoutGen]);

  // Reset windowing on equity switch.
  //
  // We deliberately do NOT touch lastDepthRef here — the data effect's else
  // branch (equityChanged path) already sets it to the new histLen at end.
  // Resetting it to 0 here would make the next data-effect run see
  // `histLen - 0 > 2 = true` and fire the depthExpanded path, which calls
  // setData with the smaller window and shifts the visible logical range
  // off the end of the data. Symptom: "after the first step the chart's
  // first entry jumps to the left side".
  useEffect(() => {
    setHistoryDepth(HISTORY_PAGE);
    fetchingRef.current = false;
  }, [equity.id]);

  // Lazy expand on overpan past the leftmost loaded bar.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const ts = chart.timeScale();
    const handler = (range: LogicalRange | null) => {
      if (!range) return;
      if (fetchingRef.current) return;
      if (range.from > -2) return;
      const ring = equity.history ?? [];
      if (ring.length <= historyDepth) return;
      fetchingRef.current = true;
      Promise.resolve().then(() => {
        fetchingRef.current = false;
        setHistoryDepth(d => Math.min(d + HISTORY_PAGE, ring.length));
      });
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => ts.unsubscribeVisibleLogicalRangeChange(handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equity.id, layoutGen, historyDepth]);

  // Position lines (avg entry / SL / TP). Re-create on every position
  // change rather than tracking individual line refs — there are at most
  // three lines and the api makes this cheap.
  useEffect(() => {
    const price = priceSeriesRef.current;
    if (!price) return;
    for (const line of priceLinesRef.current) {
      price.removePriceLine(line);
    }
    priceLinesRef.current = [];
    if (!position) return;
    priceLinesRef.current.push(
      price.createPriceLine({
        price: position.avgEntryPrice,
        color: "rgba(220, 230, 240, 0.75)",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: false,
        title: "avg",
      })
    );
    if (position.stopLoss != null) {
      priceLinesRef.current.push(
        price.createPriceLine({
          price: position.stopLoss,
          color: "#ef6f7d",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "SL",
        })
      );
    }
    if (position.takeProfit != null) {
      priceLinesRef.current.push(
        price.createPriceLine({
          price: position.takeProfit,
          color: "#6cd99a",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: "TP",
        })
      );
    }
    // Track the position's individual fields rather than the object
    // reference: the store may hand back the same object across ticks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    position?.equityId,
    position?.kind,
    position?.avgEntryPrice,
    position?.stopLoss,
    position?.takeProfit,
  ]);

  return (
    <div className="stocks-sparkline-wrap">
      <div ref={containerRef} className="stocks-sparkline" />
      {history.length < 2 && (
        <div className="stocks-sparkline-empty dim">Building price history…</div>
      )}
    </div>
  );
}

// --- T&S / order book / volume panels -----------------------------------

const ORDER_BOOK_LEVELS = 6;   // 6 asks + spread row + 6 bids = 13 rows
const TS_TAPE_ROWS = 13;
const VOLUME_HISTOGRAM_TICKS = 18;

// Order book — DOM-style vertical layout: asks at top descending (worst on
// top, best near the spread), spread row in the middle, bids below
// descending (best near the spread, worst at the bottom). Each row shows
// price · cumulative qty · size, with a depth bar sized to qty/maxQty
// across the visible levels. Reads world.orderBooks[eq.id] live.
function OrderBookPanel({ equity, world }: { equity: Equity; world: World }) {
  const book: OrderBook | undefined = world.orderBooks?.[equity.id];
  const bids = (book?.bids ?? []).slice(0, ORDER_BOOK_LEVELS);
  const asks = (book?.asks ?? []).slice(0, ORDER_BOOK_LEVELS);
  // Conventional DOM display: asks descend so the BEST ask sits just above
  // the spread row. We render them in reverse (worst first → best last).
  const asksDesc = [...asks].reverse();
  // Cumulative qty (running totals from the spread outward) — gives a
  // sense of how much has to be eaten to walk past each level. We size
  // the depth bars by cum so they build outward from the spread in a
  // smooth pyramid (smallest bar nearest the spread, largest at the
  // walls), instead of zig-zagging based on per-level qty.
  const askCum: number[] = [];
  let acc = 0;
  for (const a of asks) { acc += a.qty; askCum.push(acc); }
  const bidCum: number[] = [];
  acc = 0;
  for (const b of bids) { acc += b.qty; bidCum.push(acc); }
  // Largest cumulative depth across either side — used to scale the bars
  // so the deepest level fills the row.
  const maxCum = Math.max(1, ...askCum, ...bidCum);

  const bestBid = bids[0]?.limitPrice;
  const bestAsk = asks[0]?.limitPrice;
  const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
  const spreadPct = bestBid != null && bestAsk != null && bestBid > 0
    ? ((bestAsk - bestBid) / ((bestAsk + bestBid) / 2)) * 100
    : null;

  // Pad each side to a fixed row count so the spread row always sits in
  // the visual center — bids build downward, asks build upward, and the
  // panel doesn't jump around as depth comes and goes.
  const askPadCount = Math.max(0, ORDER_BOOK_LEVELS - asksDesc.length);
  const bidPadCount = Math.max(0, ORDER_BOOK_LEVELS - bids.length);

  return (
    <section className="trade-helper-section stocks-orderbook">
      <div className="exchange-section-title">Order book</div>
      <div className="stocks-orderbook-dom">
        <div className="stocks-orderbook-head">
          <span>Price</span>
          <span className="numeric">Size</span>
          <span className="numeric">Cum</span>
        </div>
        {Array.from({ length: askPadCount }).map((_, i) => (
          <EmptyBookRow key={`ap${i}`} side="ask" />
        ))}
        {asksDesc.map((a, i) => {
          // asks were reversed; cum index from the original asks array
          const origIdx = asks.length - 1 - i;
          return <BookRow key={`a${i}`} order={a} side="ask" maxCum={maxCum} cum={askCum[origIdx]} />;
        })}
        <div className="stocks-orderbook-spread-row">
          {spread != null && spreadPct != null ? (
            <>
              <span>spread</span>
              <span className="mono">Ç{fmtPrice(spread)}</span>
              <span className="mono dim">{spreadPct.toFixed(2)}%</span>
            </>
          ) : (
            <>
              <span className="dim">spread</span>
              <span className="mono dim">{bestBid == null && bestAsk == null ? "—" : bestBid == null ? "no bids" : "no asks"}</span>
              <span />
            </>
          )}
        </div>
        {bids.map((b, i) => (
          <BookRow key={`b${i}`} order={b} side="bid" maxCum={maxCum} cum={bidCum[i]} />
        ))}
        {Array.from({ length: bidPadCount }).map((_, i) => (
          <EmptyBookRow key={`bp${i}`} side="bid" />
        ))}
      </div>
    </section>
  );
}

function EmptyBookRow({ side }: { side: "bid" | "ask" }) {
  return (
    <div className={`stocks-orderbook-row ${side} empty`}>
      <span className="stocks-orderbook-price dim">—</span>
      <span className="stocks-orderbook-qty dim numeric">—</span>
      <span className="stocks-orderbook-cum dim numeric">—</span>
    </div>
  );
}

function BookRow({ order, side, maxCum, cum }: { order: Order; side: "bid" | "ask"; maxCum: number; cum: number }) {
  // Bars are sized by cumulative depth so they build outward from the
  // spread — best level (closest to spread) is smallest, walking outward
  // toward the walls each level adds to the bar.
  const widthPct = Math.max(2, Math.min(100, (cum / maxCum) * 100));
  return (
    <div className={`stocks-orderbook-row ${side}`}>
      <span className="stocks-orderbook-bar" style={{ width: `${widthPct}%` }} />
      <span className="stocks-orderbook-price mono">Ç{fmtPrice(order.limitPrice)}</span>
      <span className="stocks-orderbook-qty mono numeric">{Math.round(order.qty).toLocaleString()}</span>
      <span className="stocks-orderbook-cum mono numeric dim">{Math.round(cum).toLocaleString()}</span>
    </div>
  );
}

// Time & sales tape — the most recent fills against this equity, newest
// first. Color cues on side: a buyer-aggressed trade (taker took the ask)
// prints in green; seller-aggressed (taker hit the bid) in red. Mirrors
// the convention on real T&S panels.
function TimeAndSalesPanel({ equity }: { equity: Equity }) {
  const trades = (equity.recentTrades ?? []).slice(-TS_TAPE_ROWS).reverse();
  return (
    <section className="trade-helper-section stocks-tape">
      <div className="exchange-section-title">Time &amp; sales</div>
      {trades.length === 0 ? (
        <div className="stocks-tape-empty dim">No trades yet.</div>
      ) : (
        <div className="stocks-tape-rows">
          <SortableRows
            rows={trades}
            columns={[
              { id: "tick", label: "tick", getValue: trade => trade.tick, defaultDirection: "desc" },
              { id: "price", label: "price", getValue: trade => trade.price, defaultDirection: "desc" },
              { id: "qty", label: "quantity", getValue: trade => trade.qty, defaultDirection: "desc" },
              { id: "side", label: "side", getValue: trade => trade.takerSide },
            ]}
          >
            {(sortedTrades, sort) => (
              <>
                <div className="stocks-tape-head">
                  <SortableHeaderButton sort={sort} columnId="tick">Tick</SortableHeaderButton>
                  <SortableHeaderButton sort={sort} columnId="price" className="numeric">Price</SortableHeaderButton>
                  <SortableHeaderButton sort={sort} columnId="qty" className="numeric">Qty</SortableHeaderButton>
                  <SortableHeaderButton sort={sort} columnId="side">Side</SortableHeaderButton>
                </div>
                {sortedTrades.map((t, i) => (
                  <TapeRow key={`${t.tick}-${t.price}-${t.qty}-${i}`} trade={t} />
                ))}
              </>
            )}
          </SortableRows>
        </div>
      )}
    </section>
  );
}

function TapeRow({ trade }: { trade: BookTrade }) {
  const tone = trade.takerSide === "bid" ? "up" : "down";
  return (
    <div className={`stocks-tape-row ${tone}`}>
      <span className="dim mono">{trade.tick.toLocaleString()}</span>
      <span className="numeric mono">Ç{fmtPrice(trade.price)}</span>
      <span className="numeric mono">{Math.round(trade.qty).toLocaleString()}</span>
      <span className="mono">{trade.takerSide === "bid" ? "▲ buy" : "▼ sell"}</span>
    </div>
  );
}

// Volume summary — totals across the recent-trades window plus a tiny
// per-tick histogram. Buy and sell volume are shown separately so the
// tape's pressure direction is readable at a glance.
function VolumePanel({ equity, world }: { equity: Equity; world: World }) {
  // recentTrades grows unbounded; cap the totals iteration to the last
  // VOLUME_WINDOW fills so per-tick re-renders stay O(window) instead of
  // O(playtime). The histogram below uses VOLUME_HISTOGRAM_TICKS for a
  // separate per-tick bin, so this cap only affects the headline totals.
  const VOLUME_WINDOW = 500;
  const ringTrades = equity.recentTrades ?? [];
  const trades = ringTrades.length > VOLUME_WINDOW ? ringTrades.slice(-VOLUME_WINDOW) : ringTrades;
  let buyQty = 0;
  let sellQty = 0;
  for (const t of trades) {
    if (t.takerSide === "bid") buyQty += t.qty;
    else sellQty += t.qty;
  }
  const totalQty = buyQty + sellQty;

  // Per-tick histogram: the most recent VOLUME_HISTOGRAM_TICKS ticks ending
  // at the current tick. Each bar is signed (buy minus sell), drawn from
  // the centerline up (net buy) or down (net sell).
  const startTick = world.tick - VOLUME_HISTOGRAM_TICKS + 1;
  const bins: number[] = Array.from({ length: VOLUME_HISTOGRAM_TICKS }, () => 0);
  for (const t of trades) {
    const idx = t.tick - startTick;
    if (idx < 0 || idx >= VOLUME_HISTOGRAM_TICKS) continue;
    bins[idx] += (t.takerSide === "bid" ? 1 : -1) * t.qty;
  }
  const peak = Math.max(1, ...bins.map(v => Math.abs(v)));

  return (
    <section className="trade-helper-section stocks-volume">
      <div className="exchange-section-title">Volume</div>
      <dl className="stocks-volume-grid">
        <InfoStat label="window" value={`${trades.length} trades`} />
        <InfoStat label="total" value={Math.round(totalQty).toLocaleString()} />
        <InfoStat label="buy" value={Math.round(buyQty).toLocaleString()} tone="good" />
        <InfoStat label="sell" value={Math.round(sellQty).toLocaleString()} tone="bad" />
      </dl>
      <div className="stocks-volume-histogram" aria-hidden="true">
        {bins.map((v, i) => {
          const heightPct = Math.min(48, (Math.abs(v) / peak) * 48);
          const tone = v > 0 ? "up" : v < 0 ? "down" : "flat";
          return (
            <div key={i} className={`stocks-volume-bar ${tone}`}>
              <span style={{ height: `${heightPct}%` }} />
            </div>
          );
        })}
      </div>
    </section>
  );
}

// --- Phase 4: limit-order panel + open orders -----------------------------

function LimitOrderPanel({ equity, world, docked, access }: { equity: Equity; world: World; docked: boolean; access: { ok: boolean; reason: string } }) {
  const placeLimitBuy = useStore(s => s.placeLimitBuy);
  const placeLimitSell = useStore(s => s.placeLimitSell);
  const cancelLimit = useStore(s => s.cancelLimit);
  const [side, setSide] = useState<"bid" | "ask">("bid");
  const [qty, setQty] = useState<number>(10);
  const [price, setPrice] = useState<number>(equity.price);

  // Find the selected ship's open limits for this equity. Each player ship
  // has its own working orders, so the picker dictates which set we view.
  const playerShipId = useSelectedPlayerShipId(world);
  const ship = playerShipId ? world.traders[playerShipId] : null;
  const book = world.orderBooks?.[equity.id];
  const playerOrders = ship && book
    ? [...book.bids, ...book.asks].filter(o => o.agentId === ship.id)
    : [];

  // Reset price field when equity changes — keep it sticky to the user's
  // latest typed value otherwise.
  const lastEqRef = useRef(equity.id);
  useEffect(() => {
    if (lastEqRef.current !== equity.id) {
      lastEqRef.current = equity.id;
      setPrice(equity.price);
    }
  }, [equity.id, equity.price]);

  const total = qty * price;
  const fee = total * BROKER_FEE_RATE;
  const grossWithFee = total + fee;

  const onSubmit = () => {
    if (side === "bid") placeLimitBuy(equity.id, qty, price);
    else placeLimitSell(equity.id, qty, price);
  };

  return (
    <section className="stocks-info-section stocks-limit-panel">
      <div className="stocks-info-section-title">Limit orders</div>

      <div className="stocks-limit-form">
        <div className="stocks-limit-side">
          <button
            className={`stocks-limit-side-btn ${side === "bid" ? "active bid" : ""}`}
            onClick={() => setSide("bid")}
          >Buy</button>
          <button
            className={`stocks-limit-side-btn ${side === "ask" ? "active ask" : ""}`}
            onClick={() => setSide("ask")}
          >Sell</button>
        </div>
        <div className="stocks-limit-fields">
          <label>
            <span>Qty</span>
            <input
              type="number"
              min={1}
              value={qty}
              onChange={e => setQty(Math.max(1, Math.floor(Number(e.target.value) || 0)))}
            />
          </label>
          <label>
            <span>Price</span>
            <input
              type="number"
              step="0.01"
              value={price.toFixed(2)}
              onChange={e => setPrice(Math.max(0.01, Number(e.target.value) || 0))}
            />
          </label>
        </div>
        <div className="stocks-limit-summary dim">
          {side === "bid"
            ? `Reserve Ç${Math.round(grossWithFee).toLocaleString()} (${qty} × Ç${price.toFixed(2)} + ${(BROKER_FEE_RATE * 100).toFixed(0)}% fee)`
            : `Net Ç${Math.round(total - fee).toLocaleString()} on fill (after ${(BROKER_FEE_RATE * 100).toFixed(0)}% fee)`}
        </div>
        <button
          className="btn-action primary stocks-limit-submit"
          disabled={!docked || !access.ok || qty <= 0 || price <= 0}
          onClick={onSubmit}
        >
          Place {side === "bid" ? "Buy" : "Sell"} Limit
        </button>
      </div>

      {playerOrders.length > 0 && (
        <div className="stocks-open-orders">
          <div className="stocks-info-section-title">Open ({playerOrders.length})</div>
          {playerOrders.map(o => (
            <div key={o.id} className={`stocks-open-order ${o.side}`}>
              <span className="mono">{o.side === "bid" ? "BUY" : "SELL"}</span>
              <span className="mono numeric">{Math.round(o.qty)}</span>
              <span className="mono numeric">@ Ç{fmtPrice(o.limitPrice)}</span>
              <button
                className="btn-action btn-narrow"
                onClick={() => cancelLimit(equity.id, o.id)}
                title="Cancel order — refunds reserved funds or shares"
              >Cancel</button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function artCardStyle(url: string): CSSProperties {
  return { "--card-art": `url("${url}")` } as CSSProperties;
}

function equityArtUrl(world: World, eq: Equity): string | null {
  if (eq.kind === "station") {
    const loc = world.locations[eq.underlyingId];
    return loc ? stationArtUrl(loc) : null;
  }
  if (eq.kind === "syndicate") {
    const syndicate = world.syndicates[eq.underlyingId];
    const leadShipId = syndicate?.memberShipIds.find(id => world.traders[id]);
    return leadShipId ? shipArtUrl(world.traders[leadShipId]) : null;
  }
  if (eq.kind === "commodity") {
    return goodArtUrl(world, eq.underlyingId);
  }
  if (eq.kind === "basis") {
    // <locationId>::<goodId> — prefer the station's art (visually
    // distinguishes basis pairs from the underlying spot commodity).
    const sep = eq.underlyingId.indexOf("::");
    if (sep > 0) {
      const loc = world.locations[eq.underlyingId.slice(0, sep)];
      if (loc) return stationArtUrl(loc);
    }
    return null;
  }
  if (eq.kind === "futures") {
    // Use the underlying good's art so contracts on the same good
    // share visual identity.
    return goodArtUrl(world, eq.underlyingId);
  }
  // index — no per-listing art; default card style.
  return null;
}

function buildRows(world: World): EquityRow[] {
  const positions = world.player?.positions ?? {};
  const futuresPositions = world.player?.futures ?? {};
  return listEquities(world).map(eq => {
    const ratioToAnchor = eq.anchorPrice > 0 ? eq.price / eq.anchorPrice : 0;
    const position = positions[eq.id] ?? null;
    const futuresPosition = futuresPositions[eq.id] ?? null;
    const unrealized = position ? unrealizedPnl(world, position) : 0;
    const lastDividendPerShare = eq.lastDividend?.perShare ?? 0;
    const ticksUntilDividend = (DIVIDEND_INTERVAL - (world.tick % DIVIDEND_INTERVAL)) % DIVIDEND_INTERVAL || DIVIDEND_INTERVAL;
    let underlyingHealth = 1;
    let underlyingHealthLabel = "n/a";
    if (eq.kind === "station") {
      const m = world.markets[eq.underlyingId];
      if (m && m.treasuryTarget > 0) {
        underlyingHealth = m.treasury / m.treasuryTarget;
        underlyingHealthLabel = `${(underlyingHealth * 100).toFixed(0)}%`;
      }
    } else if (eq.kind === "syndicate") {
      const s = world.syndicates[eq.underlyingId];
      if (s) {
        const wealth = s.treasury + s.memberShipIds.reduce((sum, id) => sum + (world.traders[id]?.funds ?? 0), 0);
        const fair = Math.max(1, s.memberShipIds.length * 20_000);
        underlyingHealth = wealth / fair;
        underlyingHealthLabel = `${(underlyingHealth * 100).toFixed(0)}%`;
      }
    } else {
      // commodity / basis — health = current price vs anchor.
      underlyingHealth = eq.anchorPrice > 0 ? eq.price / eq.anchorPrice : 1;
      underlyingHealthLabel = `${(underlyingHealth * 100).toFixed(0)}%`;
    }
    return {
      equity: eq,
      kindLabel: KIND_LABEL[eq.kind],
      changePct: priceChangePct(eq),
      ratioToAnchor,
      position,
      futuresPosition,
      hasPosition: !!position || !!futuresPosition,
      unrealized,
      lastDividendPerShare,
      ticksUntilDividend,
      underlyingHealth,
      underlyingHealthLabel,
    };
  }).sort((a, b) => {
    return Math.abs(b.changePct) - Math.abs(a.changePct) || a.equity.name.localeCompare(b.equity.name);
  });
}

function splitRowsByAccess(world: World, rows: EquityRow[], shipId?: string): { reachable: EquityRow[]; far: EquityRow[] } {
  const reachable: EquityRow[] = [];
  const far: EquityRow[] = [];
  for (const row of rows) {
    if (exchangeAccess(world, row.equity, shipId).ok) reachable.push(row);
    else far.push(row);
  }
  return { reachable, far };
}

function exchangeAccess(world: World, eq: Equity, shipId?: string): { ok: boolean; label: string; reason: string } {
  const station = equityTradeStation(eq);
  if (!station) {
    const label = eq.kind === "commodity" ? "Commodity book: network access" : "Syndicate book: network access";
    return { ok: true, label, reason: "" };
  }
  const fallbackShipId = world.player?.shipIds[0];
  const activeShipId = shipId && world.player?.shipIds.includes(shipId) ? shipId : fallbackShipId;
  const ship = activeShipId ? world.traders[activeShipId] : null;
  const stationName = world.locations[station]?.name ?? station;
  if (!ship) return { ok: false, label: `${stationName}: no anchor ship`, reason: "No anchor ship." };
  const hops = equityTradeHopDistance(world, eq, ship.location);
  if (hops != null && hops <= EXCHANGE_TRADE_MAX_HOPS) {
    const hopLabel = hops === 0 ? "local" : `${hops} hop${hops === 1 ? "" : "s"} away`;
    return { ok: true, label: `${stationName}: ${hopLabel}`, reason: "" };
  }
  return {
    ok: false,
    label: `${stationName}: out of range`,
    reason: `Move within ${EXCHANGE_TRADE_MAX_HOPS} hops of ${stationName} to trade ${eq.ticker}.`,
  };
}

function fmtPrice(n: number): string {
  if (n >= 1000) return n.toFixed(0);
  if (n >= 100) return n.toFixed(1);
  return n.toFixed(2);
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${(n * 100).toFixed(2)}%`;
}

function fmtBig(n: number): string {
  if (Math.abs(n) >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (Math.abs(n) >= 1_000) return (n / 1_000).toFixed(1) + "k";
  return n.toFixed(0);
}

export function goodsList(world: World, ids: string[], max = 4): string {
  const shown = ids.slice(0, max).map(id => world.goods[id]?.name ?? id);
  const more = ids.length > shown.length ? ` +${ids.length - shown.length}` : "";
  return shown.length > 0 ? `${shown.join(", ")}${more}` : "None listed";
}
