import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { IconType } from "react-icons";
import { GiCargoCrate, GiFactory, GiTrade, GiUpgrade, GiWallet } from "react-icons/gi";
import { useStore } from "../store";
import type { Good, GoodCategory, GoodId, LocationDef, LocationId, World } from "../../sim/types";
import { goodArtUrl, headerArtUrl } from "../art";
import { SortableRows, SortableTh } from "../components/SortableTable";
import "./MarketsView.css";

type CommodityTone = "short" | "surplus" | "";

interface Quote {
  location: LocationId;
  locName: string;
  price: number;
  stock: number;
  target: number;
}

interface CommodityRow {
  good: Good;
  category: GoodCategory;
  totalStock: number;
  totalTarget: number;
  avgPrice: number;
  lowAsk: Quote | null;
  highBid: Quote | null;
  spreadPct: number;
  activeMarkets: number;
  tone: CommodityTone;
}

const CATEGORY_ORDER: Record<GoodCategory, number> = {
  food: 0,
  raw: 1,
  intermediate: 2,
  fuel: 3,
  advanced: 4,
  luxury: 5,
  upgrade: 6,
};

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
  { id: "all", label: "All" },
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
  const [activeCategory, setActiveCategory] = useState<CommodityTab>("all");

  const allRows = useMemo(() => commodityRows(world), [world, tickEpoch]);
  const rows = useMemo(
    () => activeCategory === "all" ? allRows : allRows.filter(row => row.category === activeCategory),
    [activeCategory, allRows],
  );
  const selectedId = selectedGood && rows.some(row => row.good.id === selectedGood) ? selectedGood : rows[0]?.good.id ?? null;
  const selected = selectedId ? rows.find(row => row.good.id === selectedId) ?? null : null;
  const tabCounts = useMemo(() => commodityTabCounts(allRows), [allRows]);

  return (
    <section className="markets-view">
      <div className="markets-layout">
        <section className="commodity-board">
          <div className="markets-card-tabs commodity-tabs">
            {COMMODITY_TABS.map(tab => (
              <button
                key={tab.id}
                className={`commodity-tab ${activeCategory === tab.id ? "active" : ""}`}
                onClick={() => setActiveCategory(tab.id)}
              >
                {tab.label} <span className="commodity-tab-count">{tabCounts[tab.id]}</span>
              </button>
            ))}
          </div>
          <div className="markets-panel-head art-panel-head" style={artCardStyle(headerArtUrl("marketBazaar"))}>
            <div>
              <span className="markets-panel-label">Board</span>
              <span className="dim">{activeCategory === "all" ? "Aggregate sector stock, demand, and station quotes" : `${CATEGORY_LABEL[activeCategory]} quotes across every station`}</span>
            </div>
            <div className="markets-legend">
              <span><span className="market-dot short" /> short</span>
              <span><span className="market-dot surplus" /> surplus</span>
              <span><span className="market-dot upgrade" /> upgrade module</span>
            </div>
          </div>
          <div className="commodity-scroll">
            <SortableRows
              rows={rows}
              columns={[
                { id: "commodity", label: "commodity", getValue: row => row.good.name },
                { id: "class", label: "class", getValue: row => CATEGORY_ORDER[row.category] },
                { id: "price", label: "average price", getValue: row => row.avgPrice, defaultDirection: "desc" },
                { id: "depth", label: "stock depth", getValue: row => row.totalStock, defaultDirection: "desc" },
                { id: "low-ask", label: "low ask", getValue: row => row.lowAsk?.price ?? null },
                { id: "high-bid", label: "high bid", getValue: row => row.highBid?.price ?? null, defaultDirection: "desc" },
                { id: "market", label: "market spread", getValue: row => row.spreadPct, defaultDirection: "desc" },
              ]}
            >
              {(sortedRows, sort) => (
                <table className="commodity-table">
                  <colgroup>
                    <col className="col-good" />
                    <col className="col-cat" />
                    <col className="col-price" />
                    <col className="col-depth" />
                    <col className="col-quote" />
                    <col className="col-quote" />
                    <col className="col-market" />
                  </colgroup>
                  <thead>
                    <tr>
                      <SortableTh sort={sort} columnId="commodity">Commodity</SortableTh>
                      <SortableTh sort={sort} columnId="class">Class</SortableTh>
                      <SortableTh sort={sort} columnId="price">Price</SortableTh>
                      <SortableTh sort={sort} columnId="depth">Depth</SortableTh>
                      <SortableTh sort={sort} columnId="low-ask">Low Ask</SortableTh>
                      <SortableTh sort={sort} columnId="high-bid">High Bid</SortableTh>
                      <SortableTh sort={sort} columnId="market">Market</SortableTh>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map(row => (
                      <tr
                        key={row.good.id}
                        className={`${selectedId === row.good.id ? "active" : ""} ${row.tone}`}
                        onClick={() => selectGood(row.good.id)}
                      >
                        <td>
                          <span className="commodity-name-cell">
                            <CommodityIcon category={row.category} />
                            <span>
                              <span className="commodity-name">{row.good.name}</span>
                              <span className="commodity-id dim">{row.good.id}</span>
                            </span>
                          </span>
                        </td>
                        <td><span className={`category-pill category-${row.category}`}>{CATEGORY_LABEL[row.category]}</span></td>
                        <td>
                          <span className="market-stack">
                            <span className="mono">Ç{row.avgPrice.toFixed(row.avgPrice >= 1000 ? 0 : 1)} avg</span>
                            <span className="mono dim">Ç{row.good.basePrice.toLocaleString()} base</span>
                          </span>
                        </td>
                        <td>
                          <span className="market-stack">
                            <span className="mono">{formatQty(row.totalStock)} stock</span>
                            <span className="mono dim">{formatQty(row.totalTarget)} target</span>
                          </span>
                        </td>
                        <td><QuoteCell quote={row.lowAsk} /></td>
                        <td><QuoteCell quote={row.highBid} /></td>
                        <td>
                          <span className="market-stack">
                            <span className={`mono ${row.spreadPct >= 75 ? "good" : row.spreadPct <= 10 ? "dim" : ""}`}>
                              {row.spreadPct.toFixed(0)}% spread
                            </span>
                            <span className="mono dim">{row.activeMarkets} markets</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </SortableRows>
          </div>
        </section>

        <aside
          className={`commodity-detail ${selected ? "market-info-card" : ""}`}
          style={selected ? artCardStyle(goodArtUrl(world, selected.good.id)) : undefined}
        >
          {selected && (
            <>
              <div className="commodity-detail-head">
                <div>
                  <span className="markets-panel-label">Commodity</span>
                  <h3>{selected.good.name}</h3>
                </div>
                <span className={`category-pill category-${selected.category}`}>{CATEGORY_LABEL[selected.category]}</span>
              </div>
              <div className="commodity-detail-stats">
                <MarketSummary icon={GiWallet} label="Base" value={`Ç${selected.good.basePrice.toLocaleString()}`} />
                <MarketSummary icon={GiCargoCrate} label="Mass" value={selected.good.weight.toFixed(1)} />
                <MarketSummary icon={GiTrade} label="Avg" value={`Ç${selected.avgPrice.toFixed(selected.avgPrice >= 1000 ? 0 : 1)}`} />
                <MarketSummary icon={GiFactory} label="Markets" value={selected.activeMarkets.toString()} />
              </div>

              <div className="commodity-depth">
                <div className="markets-section-title">Best Asks</div>
                <QuoteList quotes={quotesForGood(world, selected.good.id, "ask").slice(0, 7)} mode="ask" />
              </div>
              <div className="commodity-depth">
                <div className="markets-section-title">Best Bids</div>
                <QuoteList quotes={quotesForGood(world, selected.good.id, "bid").slice(0, 7)} mode="bid" />
              </div>
            </>
          )}
        </aside>
      </div>
    </section>
  );
}

function artCardStyle(url: string): CSSProperties {
  return { "--card-art": `url("${url}")` } as CSSProperties;
}

function MarketSummary({ icon: Icon, label, value }: { icon: IconType; label: string; value: ReactNode }) {
  return (
    <span className="markets-summary-item">
      <Icon className="markets-icon" aria-hidden="true" focusable="false" />
      <span>
        <span className="markets-summary-label">{label}</span>
        <span className="markets-summary-value">{value}</span>
      </span>
    </span>
  );
}

function CommodityIcon({ category }: { category: GoodCategory }) {
  const Icon = category === "upgrade" ? GiUpgrade : category === "fuel" ? GiTrade : GiCargoCrate;
  return <Icon className={`commodity-icon category-${category}`} aria-hidden="true" focusable="false" />;
}

function QuoteCell({ quote }: { quote: Quote | null }) {
  if (!quote) return <span className="dim">none</span>;
  return (
    <span className="quote-cell">
      <span className="quote-station">{quote.locName}</span>
      <span className="mono">Ç{quote.price.toFixed(quote.price >= 1000 ? 0 : 1)}</span>
    </span>
  );
}

function QuoteList({ quotes, mode }: { quotes: Quote[]; mode: "ask" | "bid" }) {
  return (
    <div className="quote-list">
      {quotes.length === 0 ? (
        <div className="quote-empty">No active {mode === "ask" ? "sellers" : "buyers"}.</div>
      ) : quotes.map(quote => (
        <div key={quote.location} className="quote-row">
          <span className="quote-station">{quote.locName}</span>
          <span className="mono">Ç{quote.price.toFixed(quote.price >= 1000 ? 0 : 1)}</span>
          <span className="mono dim">{mode === "ask" ? `${formatQty(quote.stock)} stock` : `${formatQty(quote.target)} target`}</span>
        </div>
      ))}
    </div>
  );
}

function commodityRows(world: World): CommodityRow[] {
  return Object.values(world.goods).map(good => commodityRow(world, good)).sort((a, b) =>
    CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category]
    || Number(b.tone === "short") - Number(a.tone === "short")
    || b.spreadPct - a.spreadPct
    || a.good.name.localeCompare(b.good.name)
  );
}

function commodityRow(world: World, good: Good): CommodityRow {
  const quotes = quotesForGood(world, good.id, "all");
  const totalStock = quotes.reduce((sum, q) => sum + q.stock, 0);
  const totalTarget = quotes.reduce((sum, q) => sum + q.target, 0);
  const avgPrice = quotes.length > 0
    ? quotes.reduce((sum, q) => sum + q.price, 0) / quotes.length
    : good.basePrice;
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
  return {
    good,
    category: good.category,
    totalStock,
    totalTarget,
    avgPrice,
    lowAsk,
    highBid,
    spreadPct,
    activeMarkets: quotes.length,
    tone,
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

function commodityTabCounts(rows: CommodityRow[]): Record<CommodityTab, number> {
  const counts = Object.fromEntries(COMMODITY_TABS.map(tab => [tab.id, 0])) as Record<CommodityTab, number>;
  counts.all = rows.length;
  for (const row of rows) counts[row.category] += 1;
  return counts;
}

function formatQty(value: number): string {
  if (value >= 1000) return Math.round(value).toLocaleString();
  if (value >= 100) return Math.round(value).toString();
  return value.toFixed(value % 1 === 0 ? 0 : 1);
}
