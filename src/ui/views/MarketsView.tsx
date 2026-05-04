import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  AreaSeries,
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { useStore } from "../store";
import { useIsMobile } from "../useIsMobile";
import { defaultMobilePanelId } from "../mobilePanels";
import type { Good, GoodCategory, GoodId, LocationDef, LocationId, World } from "../../sim/types";
import { commoditySpotPrice } from "../../sim/stock";
import { getSpotHistoryWindow } from "../historyDb";
import { goodArtUrl } from "../art";
import { SortableHeaderButton, SortableRows } from "../components/SortableTable";
import { ChangeCell, FleetStat, fmtBig, fmtPrice } from "./StockMarketView";
import "./StockMarketView.css";
import "./MarketsView.css";

type CommodityTone = "short" | "surplus" | "";

interface Quote {
  location: LocationId;
  locName: string;
  price: number;
  stock: number;
  target: number;
}

interface ProducerRow {
  location: LocationId;
  locName: string;
  ratePerTick: number;
  techLevel: number;
}

interface ConsumerRow {
  location: LocationId;
  locName: string;
  ratePerTick: number;
}

interface CommodityRow {
  good: Good;
  category: GoodCategory;
  totalStock: number;
  totalTarget: number;
  spotPrice: number;
  lowAsk: Quote | null;
  highBid: Quote | null;
  spreadPct: number;
  activeMarkets: number;
  tone: CommodityTone;
  changePct: number;
}

const CATEGORY_LABEL: Record<GoodCategory, string> = {
  food: "Food",
  raw: "Raw",
  intermediate: "Intermediate",
  fuel: "Fuel",
  advanced: "Advanced",
  luxury: "Luxury",
  upgrade: "Upgrade",
};

type CommodityTab = GoodCategory | "all";

const COMMODITY_TABS: { id: CommodityTab; label: string }[] = [
  { id: "all", label: "Commodities" },
  { id: "food", label: "Food" },
  { id: "raw", label: "Raw" },
  { id: "intermediate", label: "Parts" },
  { id: "fuel", label: "Fuel" },
  { id: "advanced", label: "Advanced" },
  { id: "luxury", label: "Luxury" },
  { id: "upgrade", label: "Upgrades" },
];

export function MarketsView() {
  const world = useStore((s) => s.world);
  const selectedGood = useStore((s) => s.selectedGood);
  const selectGood = useStore((s) => s.selectGood);
  const tickEpoch = useStore((s) => s.tickEpoch);
  const activeCategory = useStore((s) => s.commodityTab);
  const setActiveCategory = useStore((s) => s.setCommodityTab);

  const allRows = useMemo(() => commodityRows(world), [world, tickEpoch]);
  const rows = useMemo(
    () => activeCategory === "all"
      ? allRows.filter(row => row.category !== "upgrade")
      : allRows.filter(row => row.category === activeCategory),
    [activeCategory, allRows],
  );
  const selectedId = selectedGood && rows.some(row => row.good.id === selectedGood) ? selectedGood : rows[0]?.good.id ?? null;
  const selected = selectedId ? rows.find(row => row.good.id === selectedId) ?? null : null;
  const tabCounts = useMemo(() => commodityTabCounts(allRows), [allRows]);

  const isMobile = useIsMobile();
  const mobilePanel = useStore(s => s.mobilePanel.markets ?? defaultMobilePanelId("markets") ?? "listings");

  return (
    <section
      className={`markets-view stocks-view ${isMobile ? "mobile" : ""}`}
      data-mobile-panel={isMobile ? mobilePanel : undefined}
    >
      <div className="stocks-shell">
        <aside className="stocks-shell-left">
          <CommoditySelector
            rows={rows}
            tabCounts={tabCounts}
            activeCategory={activeCategory}
            selectedId={selectedId}
            onSelectCategory={setActiveCategory}
            onSelect={selectGood}
          />
        </aside>

        <aside className="stocks-shell-right">
          {selected
            ? <CommodityInfoCol world={world} row={selected} />
            : <div className="stocks-detail-empty dim">No commodities listed.</div>}
        </aside>
      </div>
    </section>
  );
}

function CommoditySelector({ rows, tabCounts, activeCategory, selectedId, onSelectCategory, onSelect }: {
  rows: CommodityRow[];
  tabCounts: Record<CommodityTab, number>;
  activeCategory: CommodityTab;
  selectedId: GoodId | null;
  onSelectCategory: (id: CommodityTab) => void;
  onSelect: (id: GoodId) => void;
}) {
  return (
    <SortableRows
      rows={rows}
      columns={[
        { id: "commodity", label: "commodity", getValue: row => row.good.name },
        { id: "spot", label: "spot price", getValue: row => row.spotPrice, defaultDirection: "desc" },
        { id: "depth", label: "stock depth", getValue: row => row.totalStock, defaultDirection: "desc" },
        { id: "low-ask", label: "low ask", getValue: row => row.lowAsk?.price ?? null },
        { id: "high-bid", label: "high bid", getValue: row => row.highBid?.price ?? null, defaultDirection: "desc" },
        { id: "spread", label: "spread", getValue: row => row.spreadPct, defaultDirection: "desc" },
      ]}
    >
      {(sortedRows, sort) => (
        <section className="stocks-shell-panel markets-selector">
          <div className="bridge-card-tabs markets-tabs">
            {COMMODITY_TABS.map(tab => (
              <button
                key={tab.id}
                type="button"
                className={`bridge-tab ${activeCategory === tab.id ? "active" : ""}`}
                onClick={() => onSelectCategory(tab.id)}
              >
                {tab.label} <span className="bridge-tab-count">{tabCounts[tab.id]}</span>
              </button>
            ))}
          </div>
          <div className="markets-selector-header">
            <SortableHeaderButton sort={sort} columnId="commodity">Commodity</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="spot" className="numeric">Spot</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="depth" className="numeric">Depth</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="low-ask" className="numeric">Low Ask</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="high-bid" className="numeric">High Bid</SortableHeaderButton>
            <SortableHeaderButton sort={sort} columnId="spread" className="numeric">Spread</SortableHeaderButton>
          </div>
          <div className="markets-selector-list" data-scroll-key={`markets:commodities:${activeCategory}`}>
            {sortedRows.length === 0
              ? <div className="stocks-detail-empty dim">No commodities in this tab.</div>
              : sortedRows.map(row => (
                <CommodityRowItem
                  key={row.good.id}
                  row={row}
                  selected={row.good.id === selectedId}
                  onSelect={onSelect}
                />
              ))}
          </div>
        </section>
      )}
    </SortableRows>
  );
}

function CommodityRowItem({ row, selected, onSelect }: {
  row: CommodityRow;
  selected: boolean;
  onSelect: (id: GoodId) => void;
}) {
  return (
    <button
      type="button"
      className={`markets-selector-row ${selected ? "selected" : ""} ${row.tone}`}
      onClick={() => onSelect(row.good.id)}
    >
      <span className="markets-selector-name">
        <span className="name">{row.good.name}</span>
        <span className="kind dim">{CATEGORY_LABEL[row.category]}</span>
      </span>
      <span className="mono numeric" title={`Base Ç${row.good.basePrice.toLocaleString()}`}>
        Ç{fmtPrice(row.spotPrice)}
      </span>
      <span className="mono numeric" title={`Target ${formatQty(row.totalTarget)} · ${row.activeMarkets} markets`}>
        {formatQty(row.totalStock)}
      </span>
      <QuoteCellInline quote={row.lowAsk} />
      <QuoteCellInline quote={row.highBid} />
      <span
        className={`mono numeric ${row.spreadPct >= 75 ? "good" : row.spreadPct <= 10 ? "dim" : ""}`}
        title={`${row.activeMarkets} active markets`}
      >
        {row.spreadPct.toFixed(0)}%
      </span>
    </button>
  );
}

function QuoteCellInline({ quote }: { quote: Quote | null }) {
  if (!quote) return <span className="mono numeric dim">—</span>;
  return (
    <span className="mono numeric" title={quote.locName}>
      Ç{fmtPrice(quote.price)}
    </span>
  );
}

function CommodityInfoCol({ world, row }: { world: World; row: CommodityRow }) {
  const artUrl = goodArtUrl(world, row.good.id);
  const history = world.commoditySpotHistory?.[row.good.id] ?? [];
  return (
    <section className="stocks-shell-panel stocks-info-col">
      <div
        className={`stocks-panel-head art-panel-head ${artUrl ? "" : "no-art"}`}
        style={artUrl ? artCardStyle(artUrl) : undefined}
      >
        <div className="stocks-info-title">
          <span className="stocks-info-eyebrow">Listed commodity</span>
          <span className="stocks-info-name">{row.good.name}</span>
          <span className="markets-info-meta">
            <span className={`category-pill category-${row.category}`}>{CATEGORY_LABEL[row.category]}</span>
          </span>
        </div>
        <div className="stocks-info-quote">
          <span className="price big mono">Ç{fmtPrice(row.spotPrice)}</span>
          <ChangeCell pct={row.changePct} />
        </div>
      </div>

      <div className="stocks-info-body" data-scroll-key={`markets:detail:${row.good.id}`}>
        <UniverseSpotChart goodId={row.good.id} history={history} basePrice={row.good.basePrice} />

        <div className="stocks-info-row">
          <CommodityKpi row={row} />
          <CommodityLogistics world={world} row={row} />
        </div>

        <BestQuotesPanel
          mode="ask"
          quotes={quotesForGood(world, row.good.id, "ask").slice(0, 7)}
        />
        <BestQuotesPanel
          mode="bid"
          quotes={quotesForGood(world, row.good.id, "bid").slice(0, 7)}
        />
        <ProducersPanel producers={producersForGood(world, row.good.id).slice(0, 5)} />
        <ConsumersPanel consumers={consumersForGood(world, row.good.id).slice(0, 5)} />
      </div>
    </section>
  );
}

function CommodityKpi({ row }: { row: CommodityRow }) {
  const stockHealth = row.totalTarget > 0 ? (row.totalStock / row.totalTarget) * 100 : null;
  const vsBase = row.good.basePrice > 0 ? row.spotPrice / row.good.basePrice : null;
  return (
    <section className="trade-helper-section markets-kpi">
      <div className="exchange-section-title">Spot</div>
      <dl className="trade-helper-grid station-info-grid">
        <FleetStat label="spot" value={`Ç${fmtPrice(row.spotPrice)}`} />
        <FleetStat label="base" value={`Ç${row.good.basePrice.toLocaleString()}`} />
        <FleetStat label="ratio" value={vsBase != null ? `${vsBase.toFixed(2)}x` : "—"} />
        <FleetStat label="mass" value={row.good.weight.toFixed(1)} />
        <FleetStat label="stock" value={fmtBig(row.totalStock)} />
        <FleetStat label="target" value={fmtBig(row.totalTarget)} />
        <FleetStat label="health" value={stockHealth != null ? `${stockHealth.toFixed(0)}%` : "—"} />
        <FleetStat label="spread" value={`${row.spreadPct.toFixed(0)}%`} />
      </dl>
    </section>
  );
}

function CommodityLogistics({ world, row }: { world: World; row: CommodityRow }) {
  const producers = producersForGood(world, row.good.id);
  const consumers = consumersForGood(world, row.good.id);
  const totalProd = producers.reduce((s, p) => s + p.ratePerTick, 0);
  const totalCons = consumers.reduce((s, c) => s + c.ratePerTick, 0);
  const net = totalProd - totalCons;
  const daysOfSupply = totalCons > 0 ? row.totalStock / totalCons : null;
  return (
    <section className="trade-helper-section markets-logistics">
      <div className="exchange-section-title">Logistics</div>
      <dl className="trade-helper-grid station-info-grid">
        <FleetStat label="markets" value={row.activeMarkets.toString()} />
        <FleetStat label="producers" value={producers.length.toString()} />
        <FleetStat label="consumers" value={consumers.length.toString()} />
        <FleetStat label="prod" value={totalProd > 0 ? totalProd.toFixed(2) : "—"} />
        <FleetStat label="cons" value={totalCons > 0 ? totalCons.toFixed(2) : "—"} />
        <FleetStat label="net" value={`${net >= 0 ? "+" : ""}${net.toFixed(2)}`} />
        <FleetStat label="runway" value={daysOfSupply != null ? `${daysOfSupply.toFixed(0)}t` : "∞"} />
      </dl>
    </section>
  );
}

function BestQuotesPanel({ mode, quotes }: { mode: "ask" | "bid"; quotes: Quote[] }) {
  return (
    <section className="trade-helper-section">
      <div className="exchange-section-title">{mode === "ask" ? "Best Asks" : "Best Bids"}</div>
      <div className="markets-quote-list">
        {quotes.length === 0
          ? <div className="markets-quote-empty dim">No active {mode === "ask" ? "sellers" : "buyers"}.</div>
          : quotes.map(quote => (
            <div key={quote.location} className="markets-quote-row">
              <span className="markets-quote-station">{quote.locName}</span>
              <span className="mono">Ç{fmtPrice(quote.price)}</span>
              <span className="mono dim">{mode === "ask" ? `${formatQty(quote.stock)} stk` : `${formatQty(quote.target)} tgt`}</span>
            </div>
          ))}
      </div>
    </section>
  );
}

function ProducersPanel({ producers }: { producers: ProducerRow[] }) {
  return (
    <section className="trade-helper-section">
      <div className="exchange-section-title">Top Producers</div>
      <div className="markets-quote-list">
        {producers.length === 0
          ? <div className="markets-quote-empty dim">No active producers.</div>
          : producers.map(p => (
            <div key={p.location} className="markets-quote-row">
              <span className="markets-quote-station">{p.locName}</span>
              <span className="mono">{p.ratePerTick.toFixed(2)}/t</span>
              <span className="mono dim">L{p.techLevel}</span>
            </div>
          ))}
      </div>
    </section>
  );
}

function ConsumersPanel({ consumers }: { consumers: ConsumerRow[] }) {
  return (
    <section className="trade-helper-section">
      <div className="exchange-section-title">Top Consumers</div>
      <div className="markets-quote-list">
        {consumers.length === 0
          ? <div className="markets-quote-empty dim">No active consumers.</div>
          : consumers.map(c => (
            <div key={c.location} className="markets-quote-row">
              <span className="markets-quote-station">{c.locName}</span>
              <span className="mono">{c.ratePerTick.toFixed(2)}/t</span>
              <span className="mono dim" />
            </div>
          ))}
      </div>
    </section>
  );
}

// Universe spot price line chart. Backed by world.commoditySpotHistory —
// the per-tick volume-weighted spot across all stations, populated by
// tickCommoditySpotHistory. Distinct from the Exchange's commodity-equity
// chart (which is EMA-smoothed and includes order-book volume bars).
//
// Same lightweight-charts pattern as Sparkline but stripped to price-only
// (no volume, no priceLines, no positions) since this view is about the
// physical good rather than a tradable instrument.
function UniverseSpotChart({ goodId, history, basePrice }: {
  goodId: GoodId;
  history: { tick: number; price: number }[];
  basePrice: number;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  // Bumps when the container first acquires a non-zero width — same trick
  // as Sparkline, lets the data effect re-fire on a real-width chart.
  const [layoutGen, setLayoutGen] = useState(0);

  const HISTORY_PAGE = 100;
  const [historyDepth, setHistoryDepth] = useState(HISTORY_PAGE);
  const [idbBackfill, setIdbBackfill] = useState<{ tick: number; price: number }[]>([]);
  const idbBackfillRef = useRef<{ tick: number; price: number }[]>([]);
  const fetchingRef = useRef<boolean>(false);
  const idbExhaustedRef = useRef<boolean>(false);
  const gameIdForChart = useStore(s => s.world.gameId);

  const allHistory = idbBackfill.length > 0 ? [...idbBackfill, ...history] : history;
  const historyStart = Math.max(0, allHistory.length - historyDepth);
  const visible = historyStart === 0 ? allHistory : allHistory.slice(historyStart);

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
      chartRef.current = chart;
      priceSeriesRef.current = price;
      ro = new ResizeObserver(() => {
        if (!chartRef.current) return;
        chartRef.current.applyOptions({ width: div.clientWidth });
        chartRef.current.timeScale().fitContent();
      });
      ro.observe(div);
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
    };
  }, []);

  // Push price data — append on incremental ticks, full setData on
  // good switch / depth expansion / first paint.
  const histLen = visible.length;
  const lastPrice = visible.length > 0 ? visible[visible.length - 1].price : 0;
  const lastTick = visible.length > 0 ? visible[visible.length - 1].tick : -1;
  const lastSeenTickRef = useRef<number>(-1);
  const lastSeenGoodRef = useRef<string>("");
  const lastLayoutGenRef = useRef<number>(0);
  const lastDepthRef = useRef<number>(0);
  useEffect(() => {
    const price = priceSeriesRef.current;
    if (!price) return;
    const points = normalizeSpotHistory(visible);
    if (points.length < 2) {
      price.setData([]);
      lastSeenTickRef.current = -1;
      lastSeenGoodRef.current = goodId;
      lastLayoutGenRef.current = layoutGen;
      lastDepthRef.current = histLen;
      return;
    }

    const goodChanged = lastSeenGoodRef.current !== goodId;
    const layoutSettled = lastLayoutGenRef.current !== layoutGen;
    // Require a non-zero prior depth to treat a jump as "user pan-left
    // expansion". Without this, async IDB hydrate (empty → 100 points)
    // looks identical to a depth expand and the visible-range shift
    // pushes the data off-screen on first paint.
    const depthExpanded = lastDepthRef.current > 0 && histLen - lastDepthRef.current > 2 && !goodChanged && !layoutSettled;
    const seen = lastSeenTickRef.current;
    const newest = points[points.length - 1].tick;
    const canAppend = !goodChanged && !layoutSettled && !depthExpanded && seen >= 0 && newest >= seen;

    if (canAppend) {
      const tail = points.filter(p => p.tick >= seen);
      for (const p of tail) {
        price.update({ time: p.tick as UTCTimestamp, value: p.price });
      }
    } else if (depthExpanded) {
      const ts = chartRef.current?.timeScale();
      const prevRange = ts?.getVisibleLogicalRange() ?? null;
      const addedCount = histLen - lastDepthRef.current;
      price.setData(points.map(p => ({ time: p.tick as UTCTimestamp, value: p.price })));
      if (ts && prevRange && addedCount > 0) {
        ts.setVisibleLogicalRange({
          from: prevRange.from + addedCount,
          to: prevRange.to + addedCount,
        });
      }
    } else {
      price.setData(points.map(p => ({ time: p.tick as UTCTimestamp, value: p.price })));
      chartRef.current?.timeScale().fitContent();
    }
    lastSeenTickRef.current = newest;
    lastSeenGoodRef.current = goodId;
    lastLayoutGenRef.current = layoutGen;
    lastDepthRef.current = histLen;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goodId, histLen, lastPrice, lastTick, layoutGen]);

  // Reset windowing on good switch.
  useEffect(() => {
    setHistoryDepth(HISTORY_PAGE);
    setIdbBackfill([]);
    idbBackfillRef.current = [];
    fetchingRef.current = false;
    idbExhaustedRef.current = false;
  }, [goodId]);

  const historyDepthRef = useRef(HISTORY_PAGE);
  historyDepthRef.current = historyDepth;

  // Lazy expand on overpan — same two-stage protocol as the Exchange
  // Sparkline. Stage 1: bump depth if the kept-in-memory window has
  // unrendered samples. Stage 2: fetch a chunk from IDB and prepend.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !gameIdForChart) return;
    const ts = chart.timeScale();
    const handler = (range: LogicalRange | null) => {
      if (!range) return;
      if (fetchingRef.current) return;
      if (range.from > -2) return;
      const ring = history;
      const backfill = idbBackfillRef.current;
      const available = backfill.length + ring.length;
      const currentDepth = historyDepthRef.current;
      if (available > currentDepth) {
        fetchingRef.current = true;
        Promise.resolve().then(() => {
          fetchingRef.current = false;
          setHistoryDepth(d => Math.min(d + HISTORY_PAGE, available));
        });
        return;
      }
      if (idbExhaustedRef.current) return;
      const earliest = backfill[0]?.tick ?? ring[0]?.tick;
      if (earliest == null || earliest <= 0) {
        idbExhaustedRef.current = true;
        return;
      }
      fetchingRef.current = true;
      const upTo = earliest - 1;
      const from = Math.max(0, upTo - HISTORY_PAGE * 5);
      void getSpotHistoryWindow(gameIdForChart, goodId, from, upTo)
        .then(samples => {
          fetchingRef.current = false;
          if (samples.length === 0) {
            idbExhaustedRef.current = true;
            return;
          }
          const chunk = samples.map(s => ({ tick: s.tick, price: s.price }));
          setIdbBackfill(prev => {
            const next = [...chunk, ...prev];
            idbBackfillRef.current = next;
            return next;
          });
          setHistoryDepth(d => d + chunk.length);
        })
        .catch(err => {
          fetchingRef.current = false;
          console.warn("[logics] markets chart IDB backfill failed", err);
        });
    };
    ts.subscribeVisibleLogicalRangeChange(handler);
    return () => ts.unsubscribeVisibleLogicalRangeChange(handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goodId, gameIdForChart, layoutGen]);

  // Dashed reference line at base price — anchors the eye when the spot
  // wanders. Re-create whenever basePrice changes (effectively just on
  // good switch).
  useEffect(() => {
    const price = priceSeriesRef.current;
    if (!price) return;
    const line = price.createPriceLine({
      price: basePrice,
      color: "rgba(220, 230, 240, 0.32)",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "base",
    });
    return () => { price.removePriceLine(line); };
  }, [basePrice, layoutGen]);

  return (
    <section className="trade-helper-section markets-chart">
      <div className="exchange-section-title">Universe Spot</div>
      <div className="stocks-sparkline-wrap">
        <div ref={containerRef} className="stocks-sparkline" />
        {visible.length < 2 && (
          <div className="stocks-sparkline-empty dim">Spot history will populate over the next few ticks.</div>
        )}
      </div>
    </section>
  );
}

function normalizeSpotHistory(history: { tick: number; price: number }[]): { tick: number; price: number }[] {
  const byTick = new Map<number, number>();
  for (const point of history) {
    if (!Number.isFinite(point.tick) || !Number.isFinite(point.price)) continue;
    byTick.set(point.tick, point.price);
  }
  return [...byTick.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tick, price]) => ({ tick, price }));
}

function artCardStyle(url: string): CSSProperties {
  return { "--card-art": `url("${url}")` } as CSSProperties;
}

function commodityRows(world: World): CommodityRow[] {
  return Object.values(world.goods)
    .map(good => commodityRow(world, good))
    .sort((a, b) => a.good.name.localeCompare(b.good.name));
}

function commodityRow(world: World, good: Good): CommodityRow {
  const quotes = quotesForGood(world, good.id, "all");
  const totalStock = quotes.reduce((sum, q) => sum + q.stock, 0);
  const totalTarget = quotes.reduce((sum, q) => sum + q.target, 0);
  const spotPrice = commoditySpotPrice(world, good.id, good.basePrice);
  const asks = quotes.filter(q => q.stock > 0.001).sort((a, b) => a.price - b.price);
  const bids = quotes.filter(q => q.target > 0).sort((a, b) => b.price - a.price);
  const lowAsk = asks[0] ?? null;
  const highBid = bids[0] ?? null;
  const spreadPct = lowAsk && highBid && lowAsk.price > 0
    ? ((highBid.price - lowAsk.price) / lowAsk.price) * 100
    : 0;
  const stockRatio = totalTarget > 0 ? totalStock / totalTarget : 1;
  const tone: CommodityTone = totalTarget > 0 && stockRatio < 0.55
    ? "short"
    : totalTarget > 0 && stockRatio > 1.8
      ? "surplus"
      : "";
  const history = world.commoditySpotHistory?.[good.id] ?? [];
  const prevSpot = history.length >= 2 ? history[history.length - 2].price : good.basePrice;
  const changePct = prevSpot > 0 ? (spotPrice - prevSpot) / prevSpot : 0;
  return {
    good,
    category: good.category,
    totalStock,
    totalTarget,
    spotPrice,
    lowAsk,
    highBid,
    spreadPct,
    activeMarkets: quotes.length,
    tone,
    changePct,
  };
}

function quotesForGood(world: World, goodId: GoodId, mode: "all" | "ask" | "bid"): Quote[] {
  const rows = Object.values(world.locations).map((loc: LocationDef) => {
    const market = world.markets[loc.id];
    return {
      location: loc.id,
      locName: loc.name,
      price: market.prices[goodId] ?? world.goods[goodId].basePrice,
      stock: market.stock[goodId] ?? 0,
      target: loc.targetStock[goodId] ?? 0,
    };
  }).filter(q => q.stock > 0.001 || q.target > 0);

  if (mode === "ask") return rows.filter(q => q.stock > 0.001).sort((a, b) => a.price - b.price || b.stock - a.stock);
  if (mode === "bid") return rows.filter(q => q.target > 0).sort((a, b) => b.price - a.price || a.stock - b.stock);
  return rows.sort((a, b) => a.locName.localeCompare(b.locName));
}

function producersForGood(world: World, goodId: GoodId): ProducerRow[] {
  const out: ProducerRow[] = [];
  for (const loc of Object.values(world.locations)) {
    const entry = loc.produces.find(p => p.good === goodId);
    if (!entry || entry.ratePerTick <= 0) continue;
    out.push({
      location: loc.id,
      locName: loc.name,
      ratePerTick: entry.ratePerTick,
      techLevel: loc.traits.techLevel,
    });
  }
  return out.sort((a, b) => b.ratePerTick - a.ratePerTick || a.locName.localeCompare(b.locName));
}

function consumersForGood(world: World, goodId: GoodId): ConsumerRow[] {
  const out: ConsumerRow[] = [];
  for (const loc of Object.values(world.locations)) {
    const entry = loc.consumes.find(c => c.good === goodId);
    if (!entry || entry.ratePerTick <= 0) continue;
    out.push({
      location: loc.id,
      locName: loc.name,
      ratePerTick: entry.ratePerTick,
    });
  }
  return out.sort((a, b) => b.ratePerTick - a.ratePerTick || a.locName.localeCompare(b.locName));
}

function commodityTabCounts(rows: CommodityRow[]): Record<CommodityTab, number> {
  const counts = Object.fromEntries(COMMODITY_TABS.map(tab => [tab.id, 0])) as Record<CommodityTab, number>;
  for (const row of rows) {
    counts[row.category] += 1;
    if (row.category !== "upgrade") counts.all += 1;
  }
  return counts;
}

function formatQty(value: number): string {
  if (value >= 1000) return Math.round(value).toLocaleString();
  if (value >= 100) return Math.round(value).toString();
  return value.toFixed(value % 1 === 0 ? 0 : 1);
}
