import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MdArrowDropDown, MdArrowDropUp, MdRemove } from "react-icons/md";
import { useStore } from "../store";
import type { BookTrade, Equity, EquityKind, Order, OrderBook, StockPosition, TradeRecord, World } from "../../sim/types";
import {
  BROKER_FEE_RATE,
  DIVIDEND_INTERVAL,
  EXCHANGE_TRADE_MAX_HOPS,
  equityTradeHopDistance,
  equityTradeStation,
  listEquities,
  listPlayerLimits,
  listPositions,
  listTradeRecords,
  maxShortableShares,
  priceChangePct,
  totalUnrealizedPnl,
  unrealizedPnl,
  type PlayerLimitView,
} from "../../sim/stock";
import { headerArtUrl, shipArtUrl, stationArtUrl, stationKind, stationKindLabel, stationScale, stationScaleLabel, stationSubtype, stationSubtypeLabel } from "../art";
import "./StockMarketView.css";

interface EquityRow {
  equity: Equity;
  kindLabel: string;
  changePct: number;
  ratioToAnchor: number;
  position: StockPosition | null;
  unrealized: number;
  lastDividendPerShare: number;
  ticksUntilDividend: number;
  underlyingHealth: number;
  underlyingHealthLabel: string;
}

const KIND_LABEL: Record<EquityKind, string> = {
  station: "Station",
  syndicate: "Syndicate",
};

export function StockMarketView() {
  const world = useStore((s) => s.world);
  const selected = useStore((s) => s.selectedEquity);
  const select = useStore((s) => s.selectEquity);
  const buyShares = useStore((s) => s.buyShares);
  const sellShares = useStore((s) => s.sellShares);
  const shortShares = useStore((s) => s.shortShares);
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
  const tapeRows = useMemo(() => splitRowsByAccess(world, rows, playerShipId), [world, rows, playerShipId]);
  const selectedId = selected && rows.some(r => r.equity.id === selected)
    ? selected
    : tapeRows.reachable[0]?.equity.id ?? rows[0]?.equity.id ?? null;
  const detail = selectedId ? rows.find(r => r.equity.id === selectedId) ?? null : null;

  const docked = !!playerShip && playerShip.state === "idle";
  const cash = playerShip?.funds ?? 0;
  const unrealizedTotal = totalUnrealizedPnl(world);
  const positions = useMemo(() => listPositions(world), [world, tickEpoch]);
  const trades = useMemo(() => listTradeRecords(world, 100), [world, tickEpoch]);
  const longCount = positions.filter(p => p.kind === "long").length;
  const shortCount = positions.filter(p => p.kind === "short").length;
  const detailArtUrl = detail ? equityArtUrl(world, detail.equity) : null;

  // If the focused position closed (sold / covered / abandoned / auto-fired
  // stop or take), drop focus so the Positions panel falls back to the full
  // list instead of showing an empty focused state.
  useEffect(() => {
    if (focusedPositionId && !positions.some(p => p.equityId === focusedPositionId)) {
      setFocusedPositionId(null);
    }
  }, [focusedPositionId, positions]);

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
            onSelect={select}
          />
          <PnoPanel
            world={world}
            positions={positions}
            trades={trades}
            shipId={playerShipId}
            cash={cash}
            docked={docked}
            onSelectEquity={select}
            onSell={(eqId, qty) => sellShares(eqId, qty)}
            onCover={(eqId, qty) => coverShares(eqId, qty)}
            onAbandon={(eqId) => {
              const pos = positions.find(p => p.equityId === eqId);
              const shares = pos?.shares ?? 0;
              const ticker = world.equities[eqId]?.ticker ?? eqId;
              if (confirm(`Abandon ${shares} shares of ${ticker}? Settles at the current mark with a 5% penalty.`)) {
                abandonPosition(eqId);
              }
            }}
            onSetStopLoss={(eqId, price) => setStopLoss(eqId, price)}
            onSetTakeProfit={(eqId, price) => setTakeProfit(eqId, price)}
          />
        </aside>

        <aside className="stocks-shell-right">
          {detail ? (
            <InfoColumn
              row={detail}
              world={world}
              shipId={playerShipId}
              docked={docked}
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

function EquitySelector({ rows, tapeRows, selectedId, onSelect }: {
  rows: EquityRow[];
  tapeRows: { reachable: EquityRow[]; far: EquityRow[] };
  selectedId: string | null;
  onSelect: (eqId: string) => void;
}) {
  void rows;
  return (
    <section className="stocks-shell-panel stocks-selector">
      <div className="stocks-panel-head art-panel-head" style={artCardStyle(headerArtUrl("stockTape"))}>
        <div>
          <span className="stocks-panel-label">Listings</span>
          <span className="dim">{tapeRows.reachable.length} reachable · {tapeRows.far.length} far</span>
        </div>
      </div>
      <div className="stocks-selector-header">
        <span>Ticker</span>
        <span>Listing</span>
        <span className="numeric">Price</span>
        <span className="numeric">Δ</span>
      </div>
      <div className="stocks-selector-list">
        {tapeRows.reachable.map(r => (
          <SelectorRow key={r.equity.id} row={r} selected={r.equity.id === selectedId} onSelect={onSelect} />
        ))}
        {tapeRows.far.length > 0 && (
          <>
            <div className="stocks-selector-divider">Out of range</div>
            {tapeRows.far.map(r => (
              <SelectorRow key={r.equity.id} row={r} selected={r.equity.id === selectedId} onSelect={onSelect} farRow />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

function SelectorRow({ row, selected, onSelect, farRow = false }: {
  row: EquityRow;
  selected: boolean;
  onSelect: (eqId: string) => void;
  farRow?: boolean;
}) {
  const eq = row.equity;
  const tone = row.changePct > 0.0005 ? "up" : row.changePct < -0.0005 ? "down" : "flat";
  const ownedTone = row.position?.kind === "long" ? "owned" : row.position?.kind === "short" ? "shorted" : "";
  return (
    <button
      type="button"
      className={`stocks-selector-row ${selected ? "selected" : ""} ${tone} ${ownedTone} ${farRow ? "far" : ""}`}
      onClick={() => onSelect(eq.id)}
    >
      <span className="ticker mono">{eq.ticker}</span>
      <span className="stocks-selector-name">
        <span className="name">{eq.name}</span>
        <span className="kind dim">{eq.kind === "station" ? "station" : "syndicate"}</span>
      </span>
      <span className="stocks-selector-price mono">Ç{fmtPrice(eq.price)}</span>
      <span className={`stocks-selector-delta mono ${tone}`}>{fmtPct(row.changePct)}</span>
    </button>
  );
}

// --- positions, orders, history (P&O) panel ----------------------------

type PnoTab = "positions" | "orders" | "history";

function PnoPanel(props: {
  world: World;
  positions: StockPosition[];
  trades: TradeRecord[];
  shipId?: string;
  cash: number;
  docked: boolean;
  onSelectEquity: (eqId: string) => void;
  onSell: (eqId: string, qty: number) => void;
  onCover: (eqId: string, qty: number) => void;
  onAbandon: (eqId: string) => void;
  onSetStopLoss: (eqId: string, price: number | null) => void;
  onSetTakeProfit: (eqId: string, price: number | null) => void;
}) {
  const [tab, setTab] = useState<PnoTab>("positions");
  const limits = useMemo(() => listPlayerLimits(props.world, props.shipId), [props.world, props.shipId]);

  return (
    <section className="stocks-shell-panel stocks-pno">
      <div className="bridge-card-tabs stocks-pno-tabs">
        <button
          className={`bridge-tab ${tab === "positions" ? "active" : ""} ${props.positions.length > 0 ? "has-suggestion" : ""}`}
          onClick={() => setTab("positions")}
        >
          Positions <span className="bridge-tab-count">{props.positions.length}</span>
        </button>
        <button
          className={`bridge-tab ${tab === "orders" ? "active" : ""} ${limits.length > 0 ? "has-suggestion" : ""}`}
          onClick={() => setTab("orders")}
        >
          Orders <span className="bridge-tab-count">{limits.length}</span>
        </button>
        <button
          className={`bridge-tab ${tab === "history" ? "active" : ""}`}
          onClick={() => setTab("history")}
        >
          History <span className="bridge-tab-count">{props.trades.length}</span>
        </button>
      </div>
      <div className="stocks-pno-body">
        {tab === "positions" && (
          <PositionsAccordion
            world={props.world}
            positions={props.positions}
            shipId={props.shipId}
            cash={props.cash}
            docked={props.docked}
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
        {tab === "history" && (
          <TradesList trades={props.trades} onSelect={props.onSelectEquity} />
        )}
      </div>
    </section>
  );
}

// --- positions accordion (multi-expand) ---------------------------------

function PositionsAccordion(props: {
  world: World;
  positions: StockPosition[];
  shipId?: string;
  cash: number;
  docked: boolean;
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
    <div className="stocks-pno-list">
      <div className="stocks-pno-header positions">
        <span>Ticker</span>
        <span>Side</span>
        <span className="numeric">Shares</span>
        <span className="numeric">Avg</span>
        <span className="numeric">P&amp;L</span>
      </div>
      {props.positions.map(pos => {
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
  );
}

function PositionAccordionItem(props: {
  world: World;
  equity: Equity;
  position: StockPosition;
  shipId?: string;
  cash: number;
  docked: boolean;
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

  const placeLimitClose = () => {
    if (pos.kind === "long") placeLimitSellAction(eq.id, closeQty, closePrice);
    else placeLimitBuyAction(eq.id, closeQty, closePrice);
  };

  return (
    <div className={`stocks-accordion-item ${props.isOpen ? "open" : ""} ${pos.kind}`}>
      <button type="button" className="stocks-accordion-summary" onClick={props.onToggle}>
        <span className="ticker mono">{eq.ticker}</span>
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
              <label className="stocks-position-field">
                <span>Qty</span>
                <input type="number" min={1} max={pos.shares} value={closeQty}
                  onChange={e => setCloseQty(Math.max(1, Math.min(pos.shares, Math.floor(Number(e.target.value) || 0))))} />
              </label>
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
              <button
                className="btn-action primary"
                disabled={!props.docked || pos.shares <= 0}
                onClick={() => (pos.kind === "long" ? props.onSell(pos.shares) : props.onCover(pos.shares))}
              >
                {pos.kind === "long" ? "Sell all" : "Cover all"}
              </button>
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
    <div className="stocks-pno-list">
      <div className="stocks-pno-header orders">
        <span>Ticker</span>
        <span>Side</span>
        <span className="numeric">Shares</span>
        <span className="numeric">Limit</span>
        <span className="numeric">Age</span>
      </div>
      {limits.map(o => {
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

function InfoColumn({ row, world, shipId, docked }: {
  row: EquityRow;
  world: World;
  shipId?: string;
  docked: boolean;
}) {
  const eq = row.equity;
  const access = exchangeAccess(world, eq, shipId);
  const artUrl = equityArtUrl(world, eq);

  return (
    <section className="stocks-shell-panel stocks-info-col">
      <div
        className={`stocks-panel-head art-panel-head ${artUrl ? "" : "no-art"}`}
        style={artUrl ? artCardStyle(artUrl) : undefined}
      >
        <div className="stocks-info-title">
          <span className="stocks-info-eyebrow">{eq.kind === "station" ? "Listed station" : "Listed company"}</span>
          <span className="stocks-info-name">{eq.name}</span>
        </div>
        <div className="stocks-info-quote">
          <span className="price big mono">Ç{fmtPrice(eq.price)}</span>
          <ChangeCell pct={row.changePct} />
        </div>
      </div>

      <div className="stocks-info-body">
        <Sparkline equity={eq} position={row.position} />

        <div className="stocks-info-row">
          <KpiPanel row={row} world={world} />
          <CompanyUnderlying eq={eq} world={world} />
        </div>

        <div className="stocks-info-row">
          <OrderBookPanel equity={eq} world={world} />
          <TimeAndSalesPanel equity={eq} />
        </div>

        <UnifiedOrderForm equity={eq} world={world} docked={docked} access={access} />
      </div>
    </section>
  );
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
        <FleetStat label="hi/low" value={trades.length > 0 ? `${fmtPrice(windowHigh)} / ${fmtPrice(windowLow)}` : "—"} />
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
function UnifiedOrderForm({ equity, world, docked, access }: {
  equity: Equity;
  world: World;
  docked: boolean;
  access: { ok: boolean; reason: string };
}) {
  void world;
  const placeLimitBuy = useStore(s => s.placeLimitBuy);
  const placeLimitSell = useStore(s => s.placeLimitSell);
  const shortShares = useStore(s => s.shortShares);

  type Side = "buy" | "sell" | "short";
  const [side, setSide] = useState<Side>("buy");
  const [qty, setQty] = useState<number>(10);
  const [price, setPrice] = useState<number>(equity.price);

  const lastEqRef = useRef(equity.id);
  useEffect(() => {
    if (lastEqRef.current !== equity.id) {
      lastEqRef.current = equity.id;
      setPrice(equity.price);
    }
  }, [equity.id, equity.price]);

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

  return (
    <section className="trade-helper-section stocks-order-form">
      <div className="exchange-section-title">Place order</div>
      <div className="stocks-order-side">
        <button className={`stocks-order-side-btn buy ${side === "buy" ? "active" : ""}`} onClick={() => setSide("buy")}>Buy</button>
        <button className={`stocks-order-side-btn sell ${side === "sell" ? "active" : ""}`} onClick={() => setSide("sell")}>Sell</button>
        <button className={`stocks-order-side-btn short ${side === "short" ? "active" : ""}`} onClick={() => setSide("short")}>Short</button>
      </div>
      <div className="stocks-order-fields">
        <label>
          <span>Qty</span>
          <input type="number" min={1} value={qty}
            onChange={e => setQty(Math.max(1, Math.floor(Number(e.target.value) || 0)))} />
        </label>
        <label>
          <span>Price</span>
          <input type="number" step="0.01" value={price.toFixed(2)}
            onChange={e => setPrice(Math.max(0.01, Number(e.target.value) || 0))}
            disabled={side === "short"} />
        </label>
        <button className="stocks-order-spot" onClick={() => setPrice(equity.price)} disabled={side === "short"}>
          Use spot
        </button>
      </div>
      <div className="stocks-order-summary dim">{summary}</div>
      <button
        className="btn-action primary stocks-order-submit"
        disabled={!docked || !access.ok || qty <= 0 || (side !== "short" && price <= 0)}
        onClick={submit}
      >
        Place {side === "buy" ? "Buy" : side === "sell" ? "Sell" : "Short"} Order
      </button>
      {!docked && <div className="stocks-warning dim">Equity trades only execute while docked.</div>}
      {!access.ok && <div className="stocks-warning dim">{access.reason}</div>}
    </section>
  );
}

function StockRowsTable({ rows, selectedId, onSelect, outOfRange = false }: {
  rows: EquityRow[];
  selectedId: string | null;
  onSelect: (equityId: string) => void;
  outOfRange?: boolean;
}) {
  if (rows.length === 0) {
    return <div className="stocks-detail-empty dim">No reachable listings.</div>;
  }
  return (
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
          <th>Ticker</th>
          <th>Listing</th>
          <th>Kind</th>
          <th>Price</th>
          <th>Δ</th>
          <th>Health</th>
          <th>Last Div</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(row => (
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

function CompanyPane({ row, world, shipId, cash, docked, hasOpposite, hasLong, onBuy, onShort }: CompanyPaneProps) {
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
    maxShortableShares(world, eq),
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
  const kind = loc ? stationKind(loc) : null;
  const subtype = loc && kind ? stationSubtype(loc, kind) : null;
  const scale = loc && kind ? stationScale(loc, kind) : null;

  return (
    <>
      <header className="stocks-info-head">
        <div className="stocks-info-title">
          <span className="stocks-info-eyebrow">{eq.kind === "station" ? "Listed station" : "Listed company"}</span>
          <span className="stocks-info-name">{eq.name}</span>
        </div>
        <span className={`station-kind-pill ${kind ? `station-kind-${kind}` : "stocks-kind-syndicate"}`}>
          {loc && kind ? stationKindLabel(kind) : "Syndicate"}
        </span>
      </header>

      <div className="stocks-info-meta">
        <span>{eq.ticker}</span>
        <span>{access.ok ? "reachable" : "out of range"}</span>
        {loc?.traits.faction && <span>{loc.traits.faction}</span>}
        {subtype && <span>{stationSubtypeLabel(subtype)}</span>}
        {scale && <span>{stationScaleLabel(scale)}</span>}
        {synd && <span>{synd.memberShipIds.length} ships</span>}
      </div>
    </>
  );
}

function CompanyUnderlying({ eq, world }: { eq: Equity; world: World }) {
  if (eq.kind === "station") {
    const market = world.markets[eq.underlyingId];
    const loc = world.locations[eq.underlyingId];
    if (!market || !loc) return null;
    return (
      <section className="trade-helper-section">
        <div className="exchange-section-title">Underlying</div>
        <dl className="trade-helper-grid station-info-grid">
          <FleetStat label="treasury" value={`Ç${fmtBig(market.treasury)}`} />
          <FleetStat label="target" value={`Ç${fmtBig(market.treasuryTarget)}`} />
          <FleetStat label="population" value={loc.population.toLocaleString()} />
          <FleetStat label="tech" value={`L${loc.traits.techLevel}`} />
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

function PositionsPanel({ positions, world, shipId, focusedId, cash, docked, onSelect, onSell, onCover, onAbandon, onSetStopLoss, onSetTakeProfit }: PositionsPanelProps) {
  if (positions.length === 0) {
    return <div className="stocks-detail-empty dim">No open positions.</div>;
  }
  const focused = focusedId ? positions.find(p => p.equityId === focusedId) ?? null : null;
  const list = focused ? [focused] : positions;
  return (
    <div className="stocks-positions-list">
      <table className="stocks-positions-table">
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Side</th>
            <th>Shares</th>
            <th>Entry</th>
            <th>Mark</th>
            <th>P&L</th>
            <th>Stop</th>
            <th>Take</th>
          </tr>
        </thead>
        <tbody>
          {list.map(pos => {
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

function TradesList({ trades, onSelect }: { trades: TradeRecord[]; onSelect: (eqId: string) => void }) {
  if (trades.length === 0) {
    return <div className="stocks-detail-empty dim">No trades yet.</div>;
  }
  return (
    <div className="stocks-trades-list">
      <table className="stocks-trades-table">
        <thead>
          <tr>
            <th>Tick</th>
            <th>Action</th>
            <th>Ticker</th>
            <th>Qty</th>
            <th>Price</th>
            <th>Cash</th>
            <th>P&L</th>
          </tr>
        </thead>
        <tbody>
          {trades.map(tr => {
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
        </tbody>
      </table>
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

// Two-panel chart: price line (top) + volume bars (bottom). Stretches to
// fill the now-wider sidebar. Volume bins per tick are signed (net buy /
// net sell) using the same convention as VolumePanel — green up from the
// centerline for net buy pressure, red down for net sell. Position
// reference lines (entry, stop, take) overlay the price panel.
function Sparkline({ equity, position }: { equity: Equity; position: StockPosition | null }) {
  const history = equity.history ?? [];
  const points = history.slice(-40);
  if (points.length < 2) return <div className="stocks-sparkline-empty dim">Building price history…</div>;

  const prices = points.map(p => p.price);
  const extras: number[] = [];
  if (position?.stopLoss != null) extras.push(position.stopLoss);
  if (position?.takeProfit != null) extras.push(position.takeProfit);
  if (position) extras.push(position.avgEntryPrice);
  const all = [...prices, ...extras];
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min || 1;

  // Layout: top price panel + small gap + bottom volume panel. viewBox stays
  // fixed; CSS scales the SVG to the container width.
  const W = 600;
  const PRICE_H = 140;
  const GAP = 8;
  const VOL_H = 44;
  const H = PRICE_H + GAP + VOL_H;
  const VOL_TOP = PRICE_H + GAP;
  const VOL_MID = VOL_TOP + VOL_H / 2;

  const minTick = points[0].tick;
  const maxTick = points[points.length - 1].tick;
  const tickSpan = Math.max(1, maxTick - minTick);
  const xFor = (tick: number) => ((tick - minTick) / tickSpan) * W;
  const yPrice = (p: number) => 2 + (1 - (p - min) / range) * (PRICE_H - 4);

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(p.tick).toFixed(1)},${yPrice(p.price).toFixed(1)}`)
    .join(" ");
  const areaPath = `${path} L${xFor(maxTick).toFixed(1)},${PRICE_H} L${xFor(minTick).toFixed(1)},${PRICE_H} Z`;
  const lastUp = points[points.length - 1].price >= points[0].price;

  // Per-tick volume bins from the recent-trades window, restricted to the
  // ticks visible in the price panel.
  const trades = equity.recentTrades ?? [];
  const buyVol: Record<number, number> = {};
  const sellVol: Record<number, number> = {};
  for (const t of trades) {
    if (t.tick < minTick || t.tick > maxTick) continue;
    if (t.takerSide === "bid") buyVol[t.tick] = (buyVol[t.tick] ?? 0) + t.qty;
    else sellVol[t.tick] = (sellVol[t.tick] ?? 0) + t.qty;
  }
  const peakVol = Math.max(1, ...Object.values(buyVol), ...Object.values(sellVol));
  const barW = Math.max(2, (W / Math.max(1, points.length)) * 0.7);

  return (
    <svg className="stocks-sparkline" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      {/* price panel background line */}
      <line x1={0} y1={PRICE_H - 0.5} x2={W} y2={PRICE_H - 0.5} className="stocks-sparkline-axis" />

      {/* price area + line */}
      <path d={areaPath} className={lastUp ? "spark-area up" : "spark-area down"} />
      <path d={path} className={lastUp ? "spark up" : "spark down"} />

      {/* position reference lines */}
      {position && (
        <line x1={0} y1={yPrice(position.avgEntryPrice)} x2={W} y2={yPrice(position.avgEntryPrice)} className="spark-entry-line" />
      )}
      {position?.stopLoss != null && (
        <line x1={0} y1={yPrice(position.stopLoss)} x2={W} y2={yPrice(position.stopLoss)} className="spark-stop-line" />
      )}
      {position?.takeProfit != null && (
        <line x1={0} y1={yPrice(position.takeProfit)} x2={W} y2={yPrice(position.takeProfit)} className="spark-take-line" />
      )}

      {/* min/max labels in price panel corners */}
      <text x={4} y={12} className="spark-label">{`Ç${fmtPrice(max)}`}</text>
      <text x={4} y={PRICE_H - 6} className="spark-label">{`Ç${fmtPrice(min)}`}</text>

      {/* volume centerline + bars */}
      <line x1={0} y1={VOL_MID} x2={W} y2={VOL_MID} className="stocks-sparkline-axis" />
      {points.map(p => {
        const buy = buyVol[p.tick] ?? 0;
        const sell = sellVol[p.tick] ?? 0;
        const x = xFor(p.tick) - barW / 2;
        const buyH = (buy / peakVol) * (VOL_H / 2);
        const sellH = (sell / peakVol) * (VOL_H / 2);
        return (
          <g key={p.tick}>
            {buy > 0 && (
              <rect
                x={x}
                y={VOL_MID - buyH}
                width={barW}
                height={buyH}
                className="vol-bar up"
              />
            )}
            {sell > 0 && (
              <rect
                x={x}
                y={VOL_MID}
                width={barW}
                height={sellH}
                className="vol-bar down"
              />
            )}
          </g>
        );
      })}

      {/* tick-range label in volume panel */}
      <text x={4} y={H - 4} className="spark-label">{`t${minTick}–${maxTick}`}</text>
    </svg>
  );
}

// --- T&S / order book / volume panels -----------------------------------

const ORDER_BOOK_LEVELS = 9;
const TS_TAPE_ROWS = 19;
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
          <div className="stocks-tape-head">
            <span>Tick</span>
            <span className="numeric">Price</span>
            <span className="numeric">Qty</span>
            <span>Side</span>
          </div>
          {trades.map((t, i) => (
            <TapeRow key={`${t.tick}-${i}`} trade={t} />
          ))}
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
  const trades = equity.recentTrades ?? [];
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

  // Find player's open limits for this equity.
  const ship = world.player ? world.traders[world.player.shipIds[0]] : null;
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
  const syndicate = world.syndicates[eq.underlyingId];
  const leadShipId = syndicate?.memberShipIds.find(id => world.traders[id]);
  return leadShipId ? shipArtUrl(world.traders[leadShipId]) : null;
}

function buildRows(world: World): EquityRow[] {
  const positions = world.player?.positions ?? {};
  return listEquities(world).map(eq => {
    const ratioToAnchor = eq.anchorPrice > 0 ? eq.price / eq.anchorPrice : 0;
    const position = positions[eq.id] ?? null;
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
    } else {
      const s = world.syndicates[eq.underlyingId];
      if (s) {
        const wealth = s.treasury + s.memberShipIds.reduce((sum, id) => sum + (world.traders[id]?.funds ?? 0), 0);
        const fair = Math.max(1, s.memberShipIds.length * 20_000);
        underlyingHealth = wealth / fair;
        underlyingHealthLabel = `${(underlyingHealth * 100).toFixed(0)}%`;
      }
    }
    return {
      equity: eq,
      kindLabel: KIND_LABEL[eq.kind],
      changePct: priceChangePct(eq),
      ratioToAnchor,
      position,
      unrealized,
      lastDividendPerShare,
      ticksUntilDividend,
      underlyingHealth,
      underlyingHealthLabel,
    };
  }).sort((a, b) => {
    const aHas = a.position ? 1 : 0;
    const bHas = b.position ? 1 : 0;
    if (aHas !== bHas) return bHas - aHas;
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
  if (!station) return { ok: true, label: "Syndicate book: network access", reason: "" };
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

function goodsList(world: World, ids: string[], max = 4): string {
  const shown = ids.slice(0, max).map(id => world.goods[id]?.name ?? id);
  const more = ids.length > shown.length ? ` +${ids.length - shown.length}` : "";
  return shown.length > 0 ? `${shown.join(", ")}${more}` : "None listed";
}
