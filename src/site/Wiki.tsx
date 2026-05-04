import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { IconType } from "react-icons";
import {
  GiCargoCrate,
  GiChart,
  GiMapleLeaf,
  GiPathDistance,
  GiShipWheel,
  GiUpgrade,
} from "react-icons/gi";
import { MdClose, MdOpenInNew, MdSearch } from "react-icons/md";
import wikiIndexSource from "../../docs/WIKI.md?raw";
import exchangeSource from "../../docs/wiki/EXCHANGE.md?raw";
import myFleetSource from "../../docs/wiki/MY_FLEET.md?raw";
import upgradesCrewSource from "../../docs/wiki/UPGRADES_AND_CREW.md?raw";

type MarkdownBlock =
  | { type: "heading"; level: number; text: string; id: string }
  | { type: "paragraph"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; headers: string[]; rows: string[][] };

interface WikiCapture {
  image: string;
  alt: string;
  label: string;
  title: string;
  text: string;
  focus?: CaptureFocus;
}

interface CaptureFocus {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface WikiPageSource {
  id: string;
  title: string;
  kicker: string;
  summary: string;
  sourcePath: string;
  sourceText: string;
  icon: IconType;
  sectionCaptures?: Record<string, WikiCapture[]>;
}

interface WikiPage extends WikiPageSource {
  blocks: MarkdownBlock[];
  headings: Extract<MarkdownBlock, { type: "heading" }>[];
  wordCount: number;
}

const pageSources: WikiPageSource[] = [
  {
    id: "overview",
    title: "Overview",
    kicker: "Start here",
    summary: "The main tabs, shared systems, and where to go next when a mechanic needs a deeper answer.",
    sourcePath: "docs/WIKI.md",
    sourceText: wikiIndexSource,
    icon: GiMapleLeaf,
  },
  {
    id: "my-fleet",
    title: "My Fleet",
    kicker: "Ship operations",
    summary: "How ships, cargo, fuel, stations, contracts, suggestions, and auto-pilot work.",
    sourcePath: "docs/wiki/MY_FLEET.md",
    sourceText: myFleetSource,
    icon: GiShipWheel,
    sectionCaptures: {
      "screen-layout": [myFleetCapture("screen-layout")],
      "top-controls": [myFleetCapture("top-controls")],
      "game-menu": [myFleetCapture("game-menu")],
      "ship-card": [myFleetCapture("fuel-hull-status"), myFleetCapture("cargo-tab")],
      "fuel": [myFleetCapture("fuel-hull-status")],
      "hull-damage-and-repairs": [myFleetCapture("fuel-hull-status")],
      "cargo-tab": [myFleetCapture("cargo-tab")],
      "upgrades-tab": [myFleetCapture("ship-upgrades-tab")],
      "crew-tab": [myFleetCapture("crew-tab")],
      "stations-and-travel": [myFleetCapture("stations-travel")],
      "station-exchange-card": [myFleetCapture("station-markets")],
      "markets": [myFleetCapture("station-markets")],
      "upgrades": [myFleetCapture("station-upgrades")],
      "offers": [myFleetCapture("station-offers")],
      "contracts": [myFleetCapture("station-contracts")],
      "info-card": [myFleetCapture("ship-info")],
      "ship-info": [myFleetCapture("ship-info")],
      "station-info": [myFleetCapture("station-info")],
      "trade-helper": [myFleetCapture("trade-helper")],
      "suggestions": [myFleetCapture("suggestions")],
      "auto-pilot": [myFleetCapture("auto-pilot")],
    },
  },
  {
    id: "exchange",
    title: "Exchange",
    kicker: "Market desk",
    summary: "How listings, order books, spot positions, limit orders, futures, stops, dividends, and settlement jobs work.",
    sourcePath: "docs/wiki/EXCHANGE.md",
    sourceText: exchangeSource,
    icon: GiChart,
    sectionCaptures: {
      "screen-layout": [exchangeCapture("screen-layout")],
      "listing-browser": [exchangeCapture("listing-browser")],
      "asset-types": [exchangeCapture("asset-filters")],
      "detail-column": [exchangeCapture("info-column")],
      "kpi-and-underlying": [exchangeCapture("kpi-underlying")],
      "order-book-and-tape": [exchangeCapture("order-book"), exchangeCapture("time-and-sales")],
      "placing-orders": [exchangeCapture("order-form")],
      "positions-tab": [exchangeCapture("positions-tab")],
      "orders-tab": [exchangeCapture("orders-tab")],
      "futures-contracts": [exchangeCapture("futures-order-form")],
      "futures-positions-tab": [exchangeCapture("futures-positions-tab")],
      "history-tab": [exchangeCapture("history-tab")],
      "basis-pairs": [exchangeCapture("basis-underlying")],
      "indices": [exchangeCapture("index-underlying")],
    },
  },
  {
    id: "upgrades-crew",
    title: "Upgrades & Crew",
    kicker: "Progression",
    summary: "Tables for modules, crew roles, modifiers, automation unlocks, maintenance, and wages.",
    sourcePath: "docs/wiki/UPGRADES_AND_CREW.md",
    sourceText: upgradesCrewSource,
    icon: GiUpgrade,
  },
];

function exchangeCapture(id: string): WikiCapture {
  const captures: Record<string, WikiCapture> = {
    "screen-layout": {
      image: "/site/screenshots/wiki/exchange/screen-layout.png",
      alt: "Exchange screen showing listing browser, positions and orders panel, and the selected market detail column",
      label: "Layout",
      title: "Exchange split view",
      text: "The Exchange pairs the listing browser and player account panels with a detail column for the selected market.",
      focus: { x: 61, y: 1, width: 38.3, height: 99 },
    },
    "listing-browser": {
      image: "/site/screenshots/wiki/exchange/listing-browser.png",
      alt: "Exchange listing browser with asset filter tabs, tickers, prices, deltas, and an out of range divider",
      label: "Listings",
      title: "Listing browser and asset filters",
      text: "The selector groups station, syndicate, commodity, basis, futures, and index listings while keeping out-of-range station books visible.",
      focus: { x: 1.2, y: 11.8, width: 97.6, height: 86.3 },
    },
    "asset-filters": {
      image: "/site/screenshots/wiki/exchange/asset-filters.png",
      alt: "Exchange listing filter tabs for all assets, stations, syndicates, commodities, basis, futures, and indices",
      label: "Asset tabs",
      title: "Major asset classes",
      text: "The top filter row is the fastest way to move between physical logistics signals and pure market instruments.",
      focus: { x: 1.2, y: 5.2, width: 97.6, height: 16.3 },
    },
    "info-column": {
      image: "/site/screenshots/wiki/exchange/info-column.png",
      alt: "Exchange detail column with quote header, chart, KPI, underlying panel, order book, time and sales, and order form",
      label: "Detail",
      title: "Selected market workspace",
      text: "The right column combines the listing art, quote, chart, KPI, underlying data, book, tape, and order entry.",
    },
    "kpi-underlying": {
      image: "/site/screenshots/wiki/exchange/kpi-underlying.png",
      alt: "Exchange KPI and underlying panels showing bid ask spread volume shares dividend and commodity fundamentals",
      label: "KPI",
      title: "KPI and underlying panels",
      text: "KPI summarizes quote quality and activity; Underlying explains what economic signal backs the selected listing.",
      focus: { x: 1.8, y: 20, width: 48.2, height: 60.4 },
    },
    "order-book": {
      image: "/site/screenshots/wiki/exchange/order-book.png",
      alt: "Exchange order book showing ask rows, spread, bid rows, sizes, and cumulative depth bars",
      label: "Book",
      title: "Order book depth ladder",
      text: "Asks stack above the spread, bids stack below it, and cumulative size shows how much depth sits away from the spread.",
      focus: { x: 3.5, y: 8.9, width: 88.9, height: 88 },
    },
    "time-and-sales": {
      image: "/site/screenshots/wiki/exchange/time-and-sales.png",
      alt: "Exchange time and sales panel showing recent ticks, prices, quantities, and buy or sell side markers",
      label: "Tape",
      title: "Time and sales tape",
      text: "The tape lists recent fills with tick, price, quantity, and whether the buyer or seller took liquidity.",
      focus: { x: 7.6, y: 8.9, width: 89, height: 88 },
    },
    "order-form": {
      image: "/site/screenshots/wiki/exchange/order-form.png",
      alt: "Exchange place order form with Buy Sell Short side buttons quantity price use spot quick chips and submit button",
      label: "Orders",
      title: "Buy, sell, and short order form",
      text: "Spot assets use one compact form for buy limits, sell limits from held shares, and market shorts.",
      focus: { x: 1.8, y: 12.7, width: 96.4, height: 13.4 },
    },
    "positions-tab": {
      image: "/site/screenshots/wiki/exchange/positions-tab.png",
      alt: "Exchange Positions tab with expanded long position showing stats close controls stop loss take profit and abandon action",
      label: "Positions",
      title: "Open long and short positions",
      text: "Expanding a position exposes mark, entry, value, P&L, close controls, stop-loss, take-profit, and abandon.",
      focus: { x: 1.2, y: 11.8, width: 97.6, height: 56.8 },
    },
    "orders-tab": {
      image: "/site/screenshots/wiki/exchange/orders-tab.png",
      alt: "Exchange Orders tab with an expanded limit order showing quantity price adjust cancel and quick chips",
      label: "Limits",
      title: "Open limit orders",
      text: "The Orders tab lists player resting limits and lets each order be adjusted or canceled from its expanded row.",
      focus: { x: 1.2, y: 11.8, width: 97.6, height: 22.5 },
    },
    "futures-order-form": {
      image: "/site/screenshots/wiki/exchange/futures-order-form.png",
      alt: "Exchange futures order form showing contracts, contract size, notional, margin, fee, expiry, and open long or short buttons",
      label: "Futures",
      title: "Futures contract order form",
      text: "Futures orders show contract count, spot mark, size, notional, margin, fee, expiry, and long or short open buttons.",
      focus: { x: 1.8, y: 67.4, width: 96.4, height: 11.5 },
    },
    "futures-positions-tab": {
      image: "/site/screenshots/wiki/exchange/futures-positions-tab.png",
      alt: "Exchange Futures tab with an expanded short futures position showing mark entry contract size margin P and L expiry delivery and close action",
      label: "Futures P&L",
      title: "Open futures positions",
      text: "The Futures tab tracks contracts, mark-to-market P&L, margin, expiry, delivery station, and physical delivery readiness.",
      focus: { x: 1.2, y: 11.8, width: 97.6, height: 38.2 },
    },
    "history-tab": {
      image: "/site/screenshots/wiki/exchange/history-tab.png",
      alt: "Exchange History tab showing tick action ticker quantity price cash flow and realized P and L columns",
      label: "Ledger",
      title: "Trade history ledger",
      text: "History records opens, adds, closes, covers, cash flow, realized P&L, and stop or take-profit tags when a trigger fires.",
      focus: { x: 1.2, y: 7.5, width: 97.6, height: 42.4 },
    },
    "basis-underlying": {
      image: "/site/screenshots/wiki/exchange/basis-underlying.png",
      alt: "Exchange basis listing selected with underlying panel showing station, good, local price, spread versus spot, and local stock",
      label: "Basis",
      title: "Station basis listing",
      text: "Basis listings tie one station and one good together, exposing local price, spread versus universe spot, and local stock.",
      focus: { x: 6.3, y: 46.4, width: 87.4, height: 27.8 },
    },
    "index-underlying": {
      image: "/site/screenshots/wiki/exchange/index-underlying.png",
      alt: "Exchange index listing selected with underlying panel showing sector basket member prices",
      label: "Index",
      title: "Sector and treasury indices",
      text: "Index listings summarize baskets such as sector commodities or overall station treasury health.",
      focus: { x: 6.3, y: 46.4, width: 87.4, height: 27.8 },
    },
  };
  return captures[id];
}

function myFleetCapture(id: string): WikiCapture {
  const captures: Record<string, WikiCapture> = {
  "screen-layout": {
    image: "/site/screenshots/wiki/my-fleet/screen-layout.png",
    alt: "My Fleet screen showing the ship card, station travel card, station exchange card, and info card",
    label: "Layout",
    title: "My Fleet bridge layout",
    text: "The selected ship sits above the station exchange and info card, with travel controls on the right.",
  },
  "game-menu": {
    image: "/site/screenshots/wiki/my-fleet/game-menu.png",
    alt: "Expanded game menu showing save slots, save actions, and developer actions",
    label: "Menu",
    title: "Game menu and save controls",
    text: "The menu exposes save slots, fleet value, tick, reset, new game, and the local developer state.",
  },
  "top-controls": {
    image: "/site/screenshots/wiki/my-fleet/top-controls.png",
    alt: "Top controls showing main tabs, tick speed, selected ship, wallet summary, and pilot mode",
    label: "Controls",
    title: "Navigation, speed, ship picker, and pilot mode",
    text: "The top bar selects the main tab, controls time, changes ships, and switches the focused ship between manual and auto.",
  },
  "fuel-hull-status": {
    image: "/site/screenshots/wiki/my-fleet/fuel-hull-status.png",
    alt: "Ship card status strip showing fuel percentage and hull damage percentage",
    label: "Status",
    title: "Fuel and hull damage actions",
    text: "The top strip of the ship card doubles as status readout and dockside action surface.",
    focus: { x: 1.2, y: 4.2, width: 97.7, height: 13.1 },
  },
  "cargo-tab": {
    image: "/site/screenshots/wiki/my-fleet/cargo-tab.png",
    alt: "Ship cargo tab showing loaded goods with quantity, profit and loss, and sell controls",
    label: "Cargo",
    title: "Cargo lots and sell actions",
    text: "Cargo rows show quantity, route-aware profit and loss, and a manual sell action when docked.",
    focus: { x: 1.2, y: 22.3, width: 97.7, height: 61.8 },
  },
  "ship-upgrades-tab": {
    image: "/site/screenshots/wiki/my-fleet/ship-upgrades-tab.png",
    alt: "Ship upgrades tab showing module slots, installed upgrades, and upgrade cargo cards",
    label: "Ship modules",
    title: "Installed upgrade slots",
    text: "The ship upgrades tab separates installed modules from upgrade cargo waiting to be installed or sold.",
    focus: { x: 2.4, y: 16.5, width: 95.2, height: 49.5 },
  },
  "crew-tab": {
    image: "/site/screenshots/wiki/my-fleet/crew-tab.png",
    alt: "Ship crew tab showing pilot, navigator, and mechanic crew cards",
    label: "Crew",
    title: "Crew stations on the ship",
    text: "Pilot, navigator, and mechanic roles live on the ship and unlock automation, guidance, and maintenance behavior.",
    focus: { x: 0.8, y: 20.3, width: 97.7, height: 63.3 },
  },
  "stations-travel": {
    image: "/site/screenshots/wiki/my-fleet/stations-travel.png",
    alt: "Stations travel card showing reachable destinations, fuel needs, travel time, and depart buttons",
    label: "Travel",
    title: "Reachable stations and departure checks",
    text: "Each route row shows destination, distance, fuel needed, travel time, local notes, and the depart action.",
    focus: { x: 1.9, y: 15.6, width: 96.3, height: 81.5 },
  },
  "station-markets": {
    image: "/site/screenshots/wiki/my-fleet/station-markets.png",
    alt: "Station exchange Markets tab showing goods, stock, held quantity, price, net sell value, and buy controls",
    label: "Market",
    title: "Station goods market",
    text: "Markets list local commodity stock, held cargo, buy price, net sell value after tax, and buy controls.",
    focus: { x: 1.2, y: 13.6, width: 97.7, height: 63.6 },
  },
  "station-upgrades": {
    image: "/site/screenshots/wiki/my-fleet/station-upgrades.png",
    alt: "Station exchange Upgrades tab showing upgrade modules for sale with prices and buy buttons",
    label: "Modules",
    title: "Station upgrade stock",
    text: "Buying from this subtab puts the module into cargo. Installing still happens from the ship card.",
    focus: { x: 2.4, y: 14.6, width: 95.2, height: 68.5 },
  },
  "station-offers": {
    image: "/site/screenshots/wiki/my-fleet/station-offers.png",
    alt: "Station exchange Offers tab showing local crew hire cards and hire buttons",
    label: "Crew board",
    title: "Local hire offers",
    text: "Crew offers show role, name, tier, modifiers, cost, wage context, and a hire action.",
    focus: { x: 2.4, y: 14.6, width: 95.2, height: 28.5 },
  },
  "station-contracts": {
    image: "/site/screenshots/wiki/my-fleet/station-contracts.png",
    alt: "Station exchange Contracts tab showing available and active work with rewards, penalties, expiry, and progress",
    label: "Contracts",
    title: "Station contract board",
    text: "Contracts show tier, requested good, destination, held amount, reward, penalty, expiry, and accept controls.",
  },
  "ship-info": {
    image: "/site/screenshots/wiki/my-fleet/ship-info.png",
    alt: "Info card showing default ship statistics, systems, service debt, and crew wages",
    label: "Info",
    title: "Default ship info",
    text: "The default info card summarizes wallet, cargo, fuel, hull damage, speed, systems, and upkeep.",
  },
  "station-info": {
    image: "/site/screenshots/wiki/my-fleet/station-info.png",
    alt: "Info card showing station details, profile, station flow, market pressure, and nearby routes",
    label: "Station",
    title: "Pinned station context",
    text: "Clicking a station row turns the info card into station context with tags, traffic, market pressure, and nearby routes.",
  },
  "trade-helper": {
    image: "/site/screenshots/wiki/my-fleet/trade-helper.png",
    alt: "Info card showing a trade helper for a selected commodity with market signals and route profit",
    label: "Helper",
    title: "Route-aware trade helper",
    text: "Clicking a good opens the trade helper with stock, prices, max buy, demand, route profit, flow, and related contracts.",
  },
  "suggestions": {
    image: "/site/screenshots/wiki/my-fleet/suggestions.png",
    alt: "My Fleet station exchange showing suggested actions and highlighted guidance markers",
    label: "Guidance",
    title: "Navigator suggestion highlights",
    text: "With a navigator hired, suggested tabs and action buttons receive route-aware guidance markers.",
  },
  "auto-pilot": {
    image: "/site/screenshots/wiki/my-fleet/auto-pilot.png",
    alt: "Top controls showing the selected ship and manual versus auto pilot mode buttons",
    label: "Automation",
    title: "Manual and Auto pilot modes",
    text: "Auto mode is per ship. It becomes available once a pilot is hired and moves dockside actions under crew control.",
    focus: { x: 87, y: 25.9, width: 12.1, height: 48.3 },
  },
  };
  return captures[id];
}

const comingSoonPages = [
  {
    title: "Markets",
    icon: GiCargoCrate,
    text: "Commodity logistics page planned. The current overview explains the tab at a high level.",
    href: "#overview-main-tabs",
  },
  {
    title: "Atlas",
    icon: GiPathDistance,
    text: "Map and route-planning page planned. The current overview covers the active behavior.",
    href: "#overview-main-tabs",
  },
];

const quickQuestions = [
  { question: "How do I automate a ship?", pageId: "my-fleet", section: "auto-pilot" },
  { question: "Why can't a ship depart?", pageId: "my-fleet", section: "stations-and-travel" },
  { question: "How do Exchange orders fill?", pageId: "exchange", section: "order-book-and-tape" },
  { question: "What do stop-loss and take-profit do?", pageId: "exchange", section: "stops-and-takes" },
  { question: "Which crew member unlocks auto-pilot?", pageId: "upgrades-crew", section: "automation-and-guidance" },
  { question: "What does each upgrade modifier mean?", pageId: "upgrades-crew", section: "shared-modifier-rules" },
];

export function Wiki() {
  const pages = useMemo(() => pageSources.map(buildWikiPage), []);
  const [activeId, setActiveId] = useState(() => pageIdFromHash(pages));
  const [query, setQuery] = useState("");
  const [modalCapture, setModalCapture] = useState<WikiCapture | null>(null);

  useEffect(() => {
    const updateFromHash = () => setActiveId(pageIdFromHash(pages));
    window.addEventListener("hashchange", updateFromHash);
    updateFromHash();
    return () => window.removeEventListener("hashchange", updateFromHash);
  }, [pages]);

  useEffect(() => {
    if (!modalCapture) return undefined;

    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModalCapture(null);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [modalCapture]);

  const activePage = pages.find((page) => page.id === activeId) ?? pages[0];
  const searchResults = useMemo(() => buildSearchResults(pages, query), [pages, query]);
  const activeQuestions = quickQuestions.filter((item) => item.pageId === activePage.id);

  return (
    <main className="wiki-shell">
      <header className="wiki-topbar">
        <a className="site-brand wiki-brand" href="/website.html" aria-label="Ledgway website home">
          <img className="site-brand-wordmark" src="/site/ledgway-wordmark.svg" alt="" />
          <img className="site-brand-mark" src="/site/ledgway-mark.svg" alt="" />
        </a>
        <nav className="wiki-top-links" aria-label="Wiki navigation">
          <a href="/website.html">Website</a>
          <a href="/">Game</a>
          <a className="active" href="/wiki.html">Wiki</a>
        </nav>
        <a className="site-link-button wiki-game-link" href="/">
          <span>Open game</span>
          <MdOpenInNew aria-hidden="true" />
        </a>
      </header>

      <section className="wiki-hero" aria-labelledby="wiki-title">
        <div>
          <span className="site-kicker">Player wiki</span>
          <h1 id="wiki-title">Learn the current build</h1>
          <p>
            Guides for fleet control, trading, upgrades, crew, automation, and the numbers behind the UI.
          </p>
        </div>
        <label className="wiki-search">
          <MdSearch aria-hidden="true" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search wiki"
          />
        </label>
      </section>

      <div className="wiki-layout">
        <aside className="wiki-sidebar" aria-label="Wiki pages">
          <div className="wiki-sidebar-section">
            <span className="wiki-sidebar-label">Pages</span>
            <nav className="wiki-page-list">
              {pages.map((page) => {
                const Icon = page.icon;
                return (
                  <a
                    key={page.id}
                    className={`wiki-page-link ${page.id === activePage.id ? "active" : ""}`}
                    href={`#${page.id}`}
                  >
                    <Icon aria-hidden="true" />
                    <span>
                      <strong>{page.title}</strong>
                      <small>{page.kicker}</small>
                    </span>
                  </a>
                );
              })}
            </nav>
          </div>

          <div className="wiki-sidebar-section">
            <span className="wiki-sidebar-label">Main Tabs Next</span>
            <div className="wiki-coming-list">
              {comingSoonPages.map((page) => {
                const Icon = page.icon;
                return (
                  <a href={page.href} key={page.title}>
                    <Icon aria-hidden="true" />
                    <span>
                      <strong>{page.title}</strong>
                      <small>{page.text}</small>
                    </span>
                  </a>
                );
              })}
            </div>
          </div>

          {query.trim() && (
            <div className="wiki-sidebar-section wiki-results">
              <span className="wiki-sidebar-label">Search Results</span>
              {searchResults.length === 0 ? (
                <p>No matching pages or sections.</p>
              ) : (
                searchResults.map((result) => (
                  <a href={result.href} key={`${result.href}-${result.label}`}>
                    <strong>{result.title}</strong>
                    <span>{result.label}</span>
                  </a>
                ))
              )}
            </div>
          )}
        </aside>

        <WikiArticle page={activePage} onOpenCapture={setModalCapture} />

        <aside className="wiki-right-rail" aria-label="Article contents">
          <section>
            <span className="wiki-sidebar-label">On This Page</span>
            <nav className="wiki-toc">
              {activePage.headings.map((heading) => (
                <a
                  className={`level-${heading.level}`}
                  href={`#${activePage.id}-${heading.id}`}
                  key={`${heading.level}-${heading.id}`}
                >
                  {heading.text}
                </a>
              ))}
            </nav>
          </section>

          <section>
            <span className="wiki-sidebar-label">Quick Answers</span>
            <div className="wiki-question-list">
              {(activeQuestions.length > 0 ? activeQuestions : quickQuestions).map((item) => {
                const page = pages.find((candidate) => candidate.id === item.pageId);
                return (
                  <a href={`#${item.pageId}-${item.section}`} key={`${item.pageId}-${item.section}`}>
                    <strong>{item.question}</strong>
                    <span>{page?.title}</span>
                  </a>
                );
              })}
            </div>
          </section>
        </aside>
      </div>

      {modalCapture && (
        <WikiCaptureModal capture={modalCapture} onClose={() => setModalCapture(null)} />
      )}
    </main>
  );
}

function WikiArticle({ page, onOpenCapture }: { page: WikiPage; onOpenCapture: (capture: WikiCapture) => void }) {
  const Icon = page.icon;
  return (
    <article className="wiki-article">
      <header className="wiki-article-head">
        <div className="wiki-article-icon">
          <Icon aria-hidden="true" />
        </div>
        <div>
          <span>{page.kicker}</span>
          <h2>{page.title}</h2>
          <p>{page.summary}</p>
          <dl>
            <div>
              <dt>Source</dt>
              <dd>{page.sourcePath}</dd>
            </div>
            <div>
              <dt>Length</dt>
              <dd>{page.wordCount.toLocaleString()} words</dd>
            </div>
          </dl>
        </div>
      </header>

      <div className="wiki-article-body">
        {page.blocks.map((block, index) => (
          <ArticleBlock
            block={block}
            blockKey={`${page.id}-${index}`}
            captures={block.type === "heading" ? page.sectionCaptures?.[block.id] : undefined}
            onOpenCapture={onOpenCapture}
            pageId={page.id}
            key={`${page.id}-${index}`}
          />
        ))}
      </div>
    </article>
  );
}

function ArticleBlock({ block, blockKey, captures, onOpenCapture, pageId }: {
  block: MarkdownBlock;
  blockKey: string;
  captures?: WikiCapture[];
  onOpenCapture: (capture: WikiCapture) => void;
  pageId: string;
}) {
  return (
    <>
      {renderBlock(block, blockKey, pageId)}
      {captures && <WikiCaptureGrid captures={captures} onOpenCapture={onOpenCapture} />}
    </>
  );
}

function WikiCaptureGrid({ captures, onOpenCapture }: {
  captures: WikiCapture[];
  onOpenCapture: (capture: WikiCapture) => void;
}) {
  return (
    <div className={`wiki-capture-grid capture-count-${captures.length}`} aria-label="Section screenshots">
      {captures.map((capture) => (
        <WikiCaptureFigure capture={capture} key={capture.image} onOpen={() => onOpenCapture(capture)} />
      ))}
    </div>
  );
}

function WikiCaptureFigure({ capture, onOpen }: { capture: WikiCapture; onOpen: () => void }) {
  const focus = capture.focus;
  const focusX = focus?.x ?? 0;
  const focusY = focus?.y ?? 0;
  const focusWidth = focus?.width ?? 0;
  const focusHeight = focus?.height ?? 0;
  const style = focus ? {
    "--focus-x": `${focusX}%`,
    "--focus-y": `${focusY}%`,
    "--focus-width": `${focusWidth}%`,
    "--focus-height": `${focusHeight}%`,
  } as CSSProperties : undefined;

  return (
    <figure className={`wiki-capture ${focus ? "has-focus" : ""}`} style={style}>
      <button
        className="wiki-capture-open"
        type="button"
        onClick={onOpen}
        aria-label={`Open full screenshot: ${capture.title}`}
      >
        <span className="wiki-capture-viewport">
          <span className="wiki-capture-stage">
            <img src={capture.image} alt={capture.alt} />
            {focus && <span className="wiki-capture-focus-box" aria-hidden="true" />}
          </span>
        </span>
      </button>
      <figcaption>
        <span>{capture.label}</span>
        <strong>{capture.title}</strong>
        <p>{capture.text}</p>
      </figcaption>
    </figure>
  );
}

function WikiCaptureModal({ capture, onClose }: { capture: WikiCapture; onClose: () => void }) {
  const [imageWidth, setImageWidth] = useState<number | null>(null);
  const style = imageWidth ? {
    "--modal-image-width": `${imageWidth}px`,
  } as CSSProperties : undefined;

  return (
    <div className="wiki-capture-modal" role="dialog" aria-modal="true" aria-label={capture.title} onClick={onClose}>
      <div className="wiki-capture-modal-panel" style={style} onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>{capture.label}</span>
            <strong>{capture.title}</strong>
          </div>
          <button type="button" onClick={onClose} aria-label="Close screenshot">
            <MdClose aria-hidden="true" />
          </button>
        </header>
        <img
          src={capture.image}
          alt={capture.alt}
          onLoad={(event) => setImageWidth(event.currentTarget.naturalWidth)}
        />
        <p>{capture.text}</p>
      </div>
    </div>
  );
}

function buildWikiPage(source: WikiPageSource): WikiPage {
  const blocks = parseMarkdown(source.sourceText);
  return {
    ...source,
    blocks,
    headings: blocks.filter((block): block is Extract<MarkdownBlock, { type: "heading" }> => block.type === "heading"),
    wordCount: source.sourceText.trim().split(/\s+/).length,
  };
}

function pageIdFromHash(pages: WikiPage[]): string {
  const hash = window.location.hash.replace(/^#/, "");
  if (!hash) return pages[0].id;
  return pages.find((page) => hash === page.id || hash.startsWith(`${page.id}-`))?.id ?? pages[0].id;
}

function parseMarkdown(source: string): MarkdownBlock[] {
  const lines = source.split(/\r?\n/);
  const blocks: MarkdownBlock[] = [];
  const slugCounts = new Map<string, number>();
  let index = 0;

  const uniqueId = (text: string) => {
    const base = slugify(text);
    const count = slugCounts.get(base) ?? 0;
    slugCounts.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };

  while (index < lines.length) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      index += 1;
      continue;
    }

    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const text = stripMarkdown(heading[2].trim());
      if (level > 1) blocks.push({ type: "heading", level, text, id: uniqueId(text) });
      index += 1;
      continue;
    }

    if (looksLikeTableStart(lines, index)) {
      const headers = parseTableRow(lines[index]);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim().includes("|")) {
        rows.push(parseTableRow(lines[index]));
        index += 1;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    if (trimmed.startsWith("- ")) {
      const items: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith("- ")) {
        items.push(lines[index].trim().slice(2).trim());
        index += 1;
      }
      blocks.push({ type: "list", items });
      continue;
    }

    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].trim().match(/^(#{1,4})\s+(.+)$/) &&
      !lines[index].trim().startsWith("- ") &&
      !looksLikeTableStart(lines, index)
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", text: paragraph.join(" ") });
  }

  return blocks;
}

function renderBlock(block: MarkdownBlock, key: string, pageId: string): ReactNode {
  if (block.type === "heading") {
    const HeadingTag = `h${Math.min(block.level, 4)}` as "h2" | "h3" | "h4";
    return (
      <HeadingTag id={`${pageId}-${block.id}`} key={key}>
        {block.text}
      </HeadingTag>
    );
  }

  if (block.type === "paragraph") {
    return <p key={key}>{renderInline(block.text)}</p>;
  }

  if (block.type === "list") {
    return (
      <ul key={key}>
        {block.items.map((item) => (
          <li key={item}>{renderInline(item)}</li>
        ))}
      </ul>
    );
  }

  return (
    <div className="wiki-table-wrap" key={key}>
      <table>
        <thead>
          <tr>
            {block.headers.map((header) => (
              <th key={header}>{renderInline(header)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`${key}-${rowIndex}`}>
              {block.headers.map((header, columnIndex) => (
                <td key={`${header}-${columnIndex}`}>{renderInline(row[columnIndex] ?? "")}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderInline(text: string): ReactNode[] {
  const tokenPattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  return text.split(tokenPattern).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }

    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }

    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (link) {
      const href = mapDocHref(link[2]);
      return (
        <a href={href} key={index}>
          {renderInline(link[1])}
        </a>
      );
    }

    return part;
  });
}

function looksLikeTableStart(lines: string[], index: number): boolean {
  const current = lines[index]?.trim() ?? "";
  const next = lines[index + 1]?.trim() ?? "";
  return current.includes("|") && looksLikeTableSeparator(next);
}

function looksLikeTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function parseTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

function slugify(text: string): string {
  return stripMarkdown(text)
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "section";
}

function mapDocHref(href: string): string {
  if (/MY_FLEET/i.test(href)) return "#my-fleet";
  if (/EXCHANGE/i.test(href)) return "#exchange";
  if (/UPGRADES_AND_CREW/i.test(href)) return "#upgrades-crew";
  if (/WIKI/i.test(href)) return "#overview";
  if (/COMMODITIES|STOCK_MARKET_REVIEW|STOCK_ORDERBOOK/i.test(href)) return "#exchange";
  return href;
}

function buildSearchResults(pages: WikiPage[], query: string): Array<{ title: string; label: string; href: string }> {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];

  const results: Array<{ title: string; label: string; href: string }> = [];
  for (const page of pages) {
    if (normalize(`${page.title} ${page.summary}`).includes(normalizedQuery)) {
      results.push({ title: page.title, label: page.summary, href: `#${page.id}` });
    }

    for (const heading of page.headings) {
      if (normalize(heading.text).includes(normalizedQuery)) {
        results.push({
          title: page.title,
          label: heading.text,
          href: `#${page.id}-${heading.id}`,
        });
      }
    }
  }

  return results.slice(0, 8);
}

function normalize(text: string): string {
  return stripMarkdown(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
