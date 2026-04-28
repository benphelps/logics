import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { MdArrowDropDown, MdArrowDropUp, MdRemove } from "react-icons/md";
import { useStore } from "../store";
import type { Equity, EquityKind, StockPosition, TradeRecord, World } from "../../sim/types";
import {
  BROKER_FEE_RATE,
  DIVIDEND_INTERVAL,
  EXCHANGE_TRADE_MAX_HOPS,
  equityTradeHopDistance,
  equityTradeStation,
  listEquities,
  listPositions,
  listTradeRecords,
  maxShortableShares,
  priceChangePct,
  totalUnrealizedPnl,
  unrealizedPnl,
} from "../../sim/stock";
import { shipArtUrl, stationArtUrl, stationKind, stationKindLabel, stationScale, stationScaleLabel, stationSubtype, stationSubtypeLabel } from "../art";
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

  return (
    <section className="stocks-view">
      {lastError && (
        <div className="stocks-error" onClick={clearError}>
          {lastError} <span className="stocks-error-dismiss">dismiss</span>
        </div>
      )}

      <div className="stocks-layout">
        <div className={`stocks-left ${focusedPositionId ? "has-focus" : ""}`}>
          <section className="stocks-main-panel">
            <div className="stocks-card-tabs stocks-main-tabs">
              <button className={`stock-main-tab ${activePanel === "tape" ? "active" : ""}`} onClick={() => setActivePanel("tape")}>
                Tape <span className="stock-tab-count">{rows.length}</span>
              </button>
              <button className={`stock-main-tab ${activePanel === "positions" ? "active" : ""}`} onClick={() => setActivePanel("positions")}>
                Positions <span className="stock-tab-count">{positions.length}</span>
              </button>
              <button className={`stock-main-tab ${activePanel === "trades" ? "active" : ""}`} onClick={() => setActivePanel("trades")}>
                Trades <span className="stock-tab-count">{trades.length}</span>
              </button>
            </div>

            <section className={`stocks-board stocks-tab-panel ${activePanel !== "tape" ? "stocks-panel-hidden" : ""}`}>
              <div className="stocks-panel-head">
                <div>
                  <span className="stocks-panel-label">Tape</span>
                  <span className="dim">{tapeRows.reachable.length} reachable · {tapeRows.far.length} out of range</span>
                </div>
                <div className="stocks-legend">
                  <span><span className="stock-dot up" /> up tick</span>
                  <span><span className="stock-dot down" /> down tick</span>
                  <span><span className="stock-dot owned" /> long</span>
                  <span><span className="stock-dot shorted" /> short</span>
                </div>
              </div>
              <div className="stocks-scroll">
                <StockRowsTable rows={tapeRows.reachable} selectedId={selectedId} onSelect={select} />
                {tapeRows.far.length > 0 && (
                  <section className="stocks-distance-group">
                    <div className="stocks-distance-head">
                      <span className="stocks-panel-label">Out of range</span>
                      <span className="dim mono">{tapeRows.far.length} station listing{tapeRows.far.length === 1 ? "" : "s"} beyond {EXCHANGE_TRADE_MAX_HOPS} hops</span>
                    </div>
                    <StockRowsTable rows={tapeRows.far} selectedId={selectedId} onSelect={select} outOfRange />
                  </section>
                )}
              </div>
            </section>

            <section className={`stocks-positions-panel stocks-tab-panel ${focusedPositionId ? "focused" : ""} ${activePanel !== "positions" ? "stocks-panel-hidden" : ""}`}>
              <div className="stocks-panel-head">
                <div>
                  <span className="stocks-panel-label">Positions</span>
                  <span className="dim">
                    {focusedPositionId
                      ? "managing one position"
                      : `${longCount} long · ${shortCount} short · click to manage`}
                  </span>
                </div>
                <div className="stocks-panel-head-right">
                  {focusedPositionId && (
                    <button className="stocks-panel-back" onClick={() => setFocusedPositionId(null)}>
                      ← Show all
                    </button>
                  )}
                  <div className="dim mono">
                    Unrealized:&nbsp;
                    <span className={unrealizedTotal > 0 ? "stock-pnl-up" : unrealizedTotal < 0 ? "stock-pnl-down" : ""}>
                      {unrealizedTotal >= 0 ? "+" : ""}Ç{Math.round(unrealizedTotal).toLocaleString()}
                    </span>
                  </div>
                </div>
              </div>
              <PositionsPanel
                positions={positions}
                world={world}
                shipId={playerShipId}
                focusedId={focusedPositionId}
                cash={cash}
                docked={docked}
                onSelect={(eqId) => {
                  select(eqId);
                  setActivePanel("positions");
                  // Toggle: clicking the focused row again returns to the
                  // full positions list.
                  setFocusedPositionId(prev => prev === eqId ? null : eqId);
                }}
                onSell={(eqId, qty) => sellShares(eqId, qty)}
                onCover={(eqId, qty) => coverShares(eqId, qty)}
                onAbandon={(eqId) => {
                  const pos = positions.find(p => p.equityId === eqId);
                  const shares = pos?.shares ?? 0;
                  const ticker = world.equities[eqId]?.ticker ?? eqId;
                  if (confirm(`Abandon ${shares} shares of ${ticker}? Settles at the current mark with a 5% penalty.`)) {
                    abandonPosition(eqId);
                    setFocusedPositionId(null);
                  }
                }}
                onSetStopLoss={(eqId, price) => setStopLoss(eqId, price)}
                onSetTakeProfit={(eqId, price) => setTakeProfit(eqId, price)}
              />
            </section>

            <section className={`stocks-trades-panel stocks-tab-panel ${activePanel !== "trades" ? "stocks-panel-hidden" : ""}`}>
              <div className="stocks-panel-head">
                <div>
                  <span className="stocks-panel-label">Trades</span>
                  <span className="dim">most recent first ({trades.length} entries)</span>
                </div>
              </div>
              <TradesList trades={trades} onSelect={(eqId) => select(eqId)} />
            </section>
          </section>
        </div>

        <aside
          className={`stocks-sidebar ${detailArtUrl ? "stocks-info-card" : ""}`}
          style={detailArtUrl ? artCardStyle(detailArtUrl) : undefined}
        >
          {detail ? (
            <CompanyPane
              row={detail}
              world={world}
              shipId={playerShipId}
              cash={cash}
              docked={docked}
              hasOpposite={detail.position?.kind === "short"}
              hasLong={detail.position?.kind === "long"}
              onBuy={(qty) => buyShares(detail.equity.id, qty)}
              onShort={(qty) => shortShares(detail.equity.id, qty)}
            />
          ) : (
            <div className="stocks-detail-empty dim">No listed equities.</div>
          )}
        </aside>
      </div>
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
    const exports = goodsList(world, loc.primaryExports);
    const imports = goodsList(world, loc.primaryImports);
    return (
      <div className="stocks-info-section">
        <div className="stocks-info-section-title">Underlying</div>
        <div className="stocks-info-line">
          <span>Treasury</span>
          <span className="mono">Ç{fmtBig(market.treasury)} / Ç{fmtBig(market.treasuryTarget)}</span>
        </div>
        <div className="stocks-info-line">
          <span>Population</span>
          <span className="mono">{loc.population.toLocaleString()} · tech L{loc.traits.techLevel}</span>
        </div>
        <div className="stocks-info-line"><span>Exports</span><span>{exports}</span></div>
        <div className="stocks-info-line"><span>Imports</span><span>{imports}</span></div>
      </div>
    );
  }
  const synd = world.syndicates[eq.underlyingId];
  if (!synd) return null;
  const memberWealth = synd.memberShipIds.reduce((s, id) => s + (world.traders[id]?.funds ?? 0), 0);
  const lead = synd.memberShipIds.map(id => world.traders[id]).find(Boolean);
  return (
    <div className="stocks-info-section">
      <div className="stocks-info-section-title">Underlying</div>
      <div className="stocks-info-line"><span>Fleet</span><span>{synd.memberShipIds.length.toLocaleString()} ships · Ç{fmtBig(memberWealth)}</span></div>
      <div className="stocks-info-line"><span>Treasury</span><span className="mono">Ç{fmtBig(synd.treasury)}</span></div>
      <div className="stocks-info-line"><span>Recent revenue</span><span className="mono">Ç{fmtBig(synd.recentRevenue)}</span></div>
      <div className="stocks-info-line"><span>Lead ship</span><span>{lead?.name ?? "Unassigned"}</span></div>
    </div>
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
  const w = 320;
  const h = 80;
  const stride = w / (points.length - 1);
  const yFor = (p: number) => h - ((p - min) / range) * (h - 4) - 2;
  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${(i * stride).toFixed(1)},${yFor(p.price).toFixed(1)}`)
    .join(" ");
  const lastUp = points[points.length - 1].price >= points[0].price;
  return (
    <svg className="stocks-sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <line x1={0} y1={h - 2} x2={w} y2={h - 2} className="stocks-sparkline-axis" />
      {position && (
        <line x1={0} y1={yFor(position.avgEntryPrice)} x2={w} y2={yFor(position.avgEntryPrice)} className="spark-entry-line" />
      )}
      {position?.stopLoss != null && (
        <line x1={0} y1={yFor(position.stopLoss)} x2={w} y2={yFor(position.stopLoss)} className="spark-stop-line" />
      )}
      {position?.takeProfit != null && (
        <line x1={0} y1={yFor(position.takeProfit)} x2={w} y2={yFor(position.takeProfit)} className="spark-take-line" />
      )}
      <path d={path} className={lastUp ? "spark up" : "spark down"} />
      <text x={4} y={12} className="spark-label">{`Ç${fmtPrice(max)}`}</text>
      <text x={4} y={h - 6} className="spark-label">{`Ç${fmtPrice(min)}`}</text>
    </svg>
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
  const synd = world.syndicates[eq.underlyingId];
  const leadShip = synd?.memberShipIds.map(id => world.traders[id]).find(Boolean);
  return leadShip ? shipArtUrl(leadShip) : null;
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
