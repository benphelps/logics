#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const DEFAULT_URL = "http://127.0.0.1:5173/";
const DEFAULT_OUT_DIRS = {
  "my-fleet": "public/site/screenshots/wiki/my-fleet",
  exchange: "public/site/screenshots/wiki/exchange",
  markets: "public/site/screenshots/wiki/markets",
  atlas: "public/site/screenshots/wiki/atlas",
  combat: "public/site/screenshots/wiki/combat",
  ledger: "public/site/screenshots/wiki/ledger",
  site: "public/site/screenshots",
  "readme-full": "public/site/screenshots/readme",
};
const DEFAULT_VIEWPORT = { width: 1600, height: 1300 };
const PUBLIC_ROOT = path.resolve("public");

const args = parseArgs(process.argv.slice(2));
const captureView = args.view ?? args.page ?? "my-fleet";
if (!DEFAULT_OUT_DIRS[captureView]) {
  throw new Error(`Unknown wiki screenshot view "${captureView}". Expected one of: ${Object.keys(DEFAULT_OUT_DIRS).join(", ")}`);
}
const targetUrl = await resolveTargetUrl(args.url ?? process.env.LEDGWAY_CAPTURE_URL ?? process.env.LOGICS_CAPTURE_URL);
const outDir = path.resolve(args.out ?? DEFAULT_OUT_DIRS[captureView]);
const keepBrowser = args.keepBrowser === "true";

const myFleetShots = [
  {
    id: "screen-layout",
    section: "screen-layout",
    label: "Layout",
    title: "Cargo bridge layout",
    text: "The selected ship sits above the station exchange and info card, with travel controls on the right.",
    alt: "Cargo screen showing the ship card, station travel card, station exchange card, and info card",
    selector: ".docked-view",
    pad: 10,
    maxHeight: 1020,
    pre: async (page) => {
      await selectShipTab(page, "Cargo");
      await selectExchangeTab(page, "Markets");
      await clearInfoFocus(page);
    },
  },
  {
    id: "game-menu",
    section: "game-menu",
    label: "Menu",
    title: "Game menu and save controls",
    text: "The menu exposes save slots, save now, new game, and developer-only controls when dev mode is enabled.",
    alt: "Save game modal showing save slots, save actions, and developer controls",
    selector: ".topbar-save-modal",
    pad: 10,
    pre: async (page) => {
      await openGameMenu(page);
    },
  },
  {
    id: "top-controls",
    section: "top-controls",
    label: "Controls",
    title: "Navigation, speed, ship picker, and tools",
    text: "The top bar selects the main tab, controls time, changes ships, and opens music or save tools.",
    alt: "Top controls showing main tabs, tick speed, selected ship, music, and save buttons",
    selector: ".topbar-shell",
    pad: 8,
    pre: async (page) => {
      await closeGameMenu(page);
    },
  },
  {
    id: "fuel-hull-status",
    section: "fuel",
    label: "Status",
    title: "Fuel and hull damage actions",
    text: "The top strip of the ship card doubles as status readout and dockside action surface.",
    alt: "Ship card status strip showing fuel percentage and hull damage percentage",
    selector: ".ship-card",
    focusSelector: ".ship-status-tabs",
    pad: 10,
    maxHeight: 260,
    pre: async (page) => {
      await selectShipTab(page, "Cargo");
      await clearInfoFocus(page);
    },
  },
  {
    id: "cargo-tab",
    section: "cargo-tab",
    label: "Cargo",
    title: "Cargo lots and sell actions",
    text: "Cargo rows show quantity, route-aware profit and loss, and a manual sell action when docked.",
    alt: "Ship cargo tab showing a loaded good with quantity, profit and loss, and sell controls",
    selector: ".ship-card",
    focusSelector: ".cargo-table-zone",
    pad: 10,
    maxHeight: 360,
    pre: async (page) => {
      await selectShipTab(page, "Cargo");
    },
  },
  {
    id: "ship-upgrades-tab",
    section: "upgrades-tab",
    label: "Ship modules",
    title: "Installed upgrade slots",
    text: "The ship upgrades tab separates installed modules from upgrade cargo waiting to be installed or sold.",
    alt: "Ship upgrades tab showing module slots and installed upgrades",
    selector: ".ship-card",
    focusSelector: ".upgrade-slot-grid",
    pad: 10,
    maxHeight: 650,
    pre: async (page) => {
      await selectShipTab(page, "Upgrades");
    },
  },
  {
    id: "crew-tab",
    section: "crew-tab",
    label: "Crew",
    title: "Crew stations on the ship",
    text: "Pilot, navigator, mechanic, and mercenary roles live on the ship and unlock automation, guidance, upkeep, and combat support.",
    alt: "Ship crew tab showing pilot, navigator, mechanic, and mercenary crew cards",
    selector: ".ship-card",
    focusSelector: ".crew-card-grid",
    pad: 10,
    maxHeight: 420,
    pre: async (page) => {
      await selectShipTab(page, "Crew");
    },
  },
  {
    id: "stations-travel",
    section: "stations-and-travel",
    label: "Travel",
    title: "Reachable stations and departure checks",
    text: "Each route row shows destination, distance, fuel needed, travel time, local notes, and the depart action.",
    alt: "Stations travel card showing reachable destinations, fuel needs, travel time, and depart buttons",
    selector: ".travel-card",
    focusSelector: ".travel-table-zone",
    pad: 10,
    pre: async (page) => {
      await selectShipTab(page, "Cargo");
      await clearInfoFocus(page);
    },
  },
  {
    id: "station-markets",
    section: "markets",
    label: "Market",
    title: "Station goods market",
    text: "Markets list local commodity stock, held cargo, buy price, net sell value after tax, and buy controls.",
    alt: "Station exchange Markets tab showing goods, stock, held quantity, price, net sell value, and buy controls",
    selector: ".exchange-card",
    focusSelector: ".market-table",
    pad: 10,
    pre: async (page) => {
      await selectShipTab(page, "Cargo");
      await selectExchangeTab(page, "Markets");
    },
  },
  {
    id: "station-upgrades",
    section: "upgrades",
    label: "Modules",
    title: "Station upgrade stock",
    text: "Buying from this subtab puts the module into cargo. Installing still happens from the ship card.",
    alt: "Station exchange Upgrades tab showing upgrade modules for sale with prices and buy buttons",
    selector: ".exchange-card",
    focusSelector: ".station-upgrade-grid",
    pad: 10,
    pre: async (page) => {
      await selectExchangeTab(page, "Upgrades");
    },
  },
  {
    id: "station-offers",
    section: "offers",
    label: "Crew board",
    title: "Local hire offers",
    text: "Crew offers show role, name, tier, modifiers, cost, wage context, and a hire action.",
    alt: "Station exchange Offers tab showing local crew hire cards and hire buttons",
    selector: ".exchange-card",
    focusSelector: ".crew-offer-grid",
    pad: 10,
    pre: async (page) => {
      await selectExchangeTab(page, "Offers");
    },
  },
  {
    id: "station-contracts",
    section: "contracts",
    label: "Contracts",
    title: "Station contract board",
    text: "Contracts show tier, requested good, destination, held amount, reward, penalty, expiry, and accept controls.",
    alt: "Station exchange Contracts tab showing available work with tier, route, reward, penalty, expiry, and accept controls",
    selector: ".exchange-card",
    pad: 10,
    pre: async (page) => {
      await selectExchangeTab(page, "Contracts");
    },
  },
  {
    id: "ship-info",
    section: "ship-info",
    label: "Info",
    title: "Default ship info",
    text: "The default info card summarizes wallet, cargo, fuel, hull damage, speed, systems, and upkeep.",
    alt: "Info card showing default ship statistics, systems, service debt, and crew wages",
    selector: ".info-area-card",
    pad: 10,
    pre: async (page) => {
      await clearInfoFocus(page);
    },
  },
  {
    id: "station-info",
    section: "station-info",
    label: "Station",
    title: "Pinned station context",
    text: "Clicking a station row turns the info card into station context with tags, traffic, market pressure, and nearby routes.",
    alt: "Info card showing station details, profile, station flow, market pressure, and nearby routes",
    selector: ".info-area-card",
    pad: 10,
    pre: async (page) => {
      await clickSelector(page, ".travel-current-station.info-focus-trigger");
      await page.wait(180);
    },
  },
  {
    id: "trade-helper",
    section: "trade-helper",
    label: "Helper",
    title: "Route-aware trade helper",
    text: "Clicking a good opens the trade helper with stock, prices, max buy, demand, route profit, flow, and related contracts.",
    alt: "Info card showing a trade helper for a selected commodity with market signals and route profit",
    selector: ".info-area-card",
    pad: 10,
    pre: async (page) => {
      await selectExchangeTab(page, "Markets");
      await clickSelector(page, ".market-table tbody tr.info-focus-row:first-child");
      await page.wait(180);
    },
  },
  {
    id: "suggestions",
    section: "suggestions",
    label: "Guidance",
    title: "Navigator suggestion highlights",
    text: "With a navigator hired, suggested tabs and action buttons receive route-aware guidance markers.",
    alt: "Cargo station exchange showing suggested actions and highlighted guidance markers",
    selector: ".docked-view",
    showSuggestions: true,
    pad: 10,
    maxHeight: 760,
    pre: async (page) => {
      await selectShipTab(page, "Cargo");
      await selectExchangeTab(page, "Markets");
      await clearInfoFocus(page);
    },
  },
  {
    id: "auto-pilot",
    section: "auto-pilot",
    label: "Automation",
    title: "Manual and Auto pilot modes",
    text: "Auto mode is per ship. It becomes available once a pilot is hired and moves dockside actions under crew control.",
    alt: "Top controls showing the selected ship and manual versus auto pilot mode buttons",
    selector: ".ship-card",
    focusSelector: ".ship-pilot-entry",
    pad: 10,
    pre: async (page) => {
      await selectShipTab(page, "Cargo");
      await clickSelector(page, ".ship-pilot-entry");
      await page.wait(180);
    },
  },
];

const exchangeShots = [
  {
    id: "screen-layout",
    section: "screen-layout",
    label: "Layout",
    title: "Exchange split view",
    text: "The Exchange pairs the listing browser and player account panels with a detail column for the selected market.",
    alt: "Exchange screen showing listing browser, positions and orders panel, and the selected market detail column",
    selector: ".stocks-shell",
    focusSelector: ".stocks-shell-right",
    pad: 10,
    maxHeight: 1040,
    pre: async (page) => {
      await selectExchangeListing(page, "commodity");
      await selectPnoTab(page, "Positions");
      await closeGameMenu(page);
    },
  },
  {
    id: "listing-browser",
    section: "listing-browser",
    label: "Listings",
    title: "Listing browser and asset filters",
    text: "The selector groups station, syndicate, commodity, basis, futures, and index listings while keeping out-of-range station books visible.",
    alt: "Exchange listing browser with asset filter tabs, tickers, prices, deltas, and an out of range divider",
    selector: ".stocks-selector",
    focusSelector: ".stocks-selector-list",
    pad: 10,
    pre: async (page) => {
      await selectExchangeListing(page, "all");
    },
  },
  {
    id: "asset-filters",
    section: "asset-types",
    label: "Asset tabs",
    title: "Major asset classes",
    text: "The top filter row is the fastest way to move between physical logistics signals and pure market instruments.",
    alt: "Exchange listing filter tabs for all assets, stations, syndicates, commodities, basis, futures, and indices",
    selector: ".stocks-selector",
    focusSelector: ".stocks-selector .stocks-pno-tabs",
    pad: 10,
    maxHeight: 210,
    pre: async (page) => {
      await selectExchangeListing(page, "commodity");
    },
  },
  {
    id: "info-column",
    section: "detail-column",
    label: "Detail",
    title: "Selected market workspace",
    text: "The right column combines the listing art, quote, chart, KPI, underlying data, book, tape, and order entry.",
    alt: "Exchange detail column with quote header, chart, KPI, underlying panel, order book, time and sales, and order form",
    selector: ".stocks-info-col",
    pad: 10,
    maxHeight: 1040,
    pre: async (page) => {
      await selectExchangeListing(page, "commodity");
    },
  },
  {
    id: "kpi-underlying",
    section: "kpi-and-underlying",
    label: "KPI",
    title: "KPI and underlying panels",
    text: "KPI summarizes quote quality and activity; Underlying explains what economic signal backs the selected listing.",
    alt: "Exchange KPI and underlying panels showing bid ask spread volume shares dividend and commodity fundamentals",
    selector: ".stocks-info-body > .stocks-info-row:nth-of-type(2)",
    focusSelector: ".stocks-kpi",
    pad: 10,
    pre: async (page) => {
      await selectExchangeListing(page, "commodity");
    },
  },
  {
    id: "order-book",
    section: "order-book-and-tape",
    label: "Book",
    title: "Order book depth ladder",
    text: "Asks stack above the spread, bids stack below it, and cumulative size shows how much depth sits away from the spread.",
    alt: "Exchange order book showing ask rows, spread, bid rows, sizes, and cumulative depth bars",
    selector: ".stocks-orderbook",
    focusSelector: ".stocks-orderbook-dom",
    pad: 10,
    pre: async (page) => {
      await selectExchangeListing(page, "commodity");
    },
  },
  {
    id: "time-and-sales",
    section: "order-book-and-tape",
    label: "Tape",
    title: "Time and sales tape",
    text: "The tape lists recent fills with tick, price, quantity, and whether the buyer or seller took liquidity.",
    alt: "Exchange time and sales panel showing recent ticks, prices, quantities, and buy or sell side markers",
    selector: ".stocks-tape",
    focusSelector: ".stocks-tape-rows",
    pad: 10,
    pre: async (page) => {
      await selectExchangeListing(page, "commodity");
    },
  },
  {
    id: "order-form",
    section: "placing-orders",
    label: "Orders",
    title: "Buy, sell, and short order form",
    text: "Spot assets use one compact form for buy limits, sell limits from held shares, and market shorts.",
    alt: "Exchange place order form with Buy Sell Short side buttons quantity price use spot quick chips and submit button",
    selector: ".stocks-order-form",
    focusSelector: ".stocks-order-side",
    pad: 10,
    pre: async (page) => {
      await selectExchangeListing(page, "commodity");
    },
  },
  {
    id: "positions-tab",
    section: "positions-tab",
    label: "Positions",
    title: "Open long and short positions",
    text: "Expanding a position exposes mark, entry, value, P&L, close controls, stop-loss, take-profit, and abandon.",
    alt: "Exchange Positions tab with expanded long position showing stats close controls stop loss take profit and abandon action",
    selector: ".stocks-pno",
    focusSelector: ".stocks-accordion-item.open",
    pad: 10,
    pre: async (page) => {
      await selectExchangeListing(page, "commodity");
      await selectPnoTab(page, "Positions");
      await openFirstAccordion(page);
    },
  },
  {
    id: "orders-tab",
    section: "orders-tab",
    label: "Limits",
    title: "Open limit orders",
    text: "The Orders tab lists player resting limits and lets each order be adjusted or canceled from its expanded row.",
    alt: "Exchange Orders tab with an expanded limit order showing quantity price adjust cancel and quick chips",
    selector: ".stocks-pno",
    focusSelector: ".stocks-accordion-item.open",
    pad: 10,
    pre: async (page) => {
      await selectPnoTab(page, "Orders");
      await openFirstAccordion(page);
    },
  },
  {
    id: "futures-order-form",
    section: "futures-contracts",
    label: "Futures",
    title: "Futures contract order form",
    text: "Futures orders show contract count, spot mark, size, notional, margin, fee, expiry, and long or short open buttons.",
    alt: "Exchange futures order form showing contracts, contract size, notional, margin, fee, expiry, and open long or short buttons",
    selector: ".stocks-order-form",
    focusSelector: ".stocks-order-side",
    pad: 10,
    pre: async (page) => {
      await selectExchangeListing(page, "futures");
      await selectPnoTab(page, "Futures");
    },
  },
  {
    id: "futures-positions-tab",
    section: "futures-positions-tab",
    label: "Futures P&L",
    title: "Open futures positions",
    text: "The Futures tab tracks contracts, mark-to-market P&L, margin, expiry, delivery station, and physical delivery readiness.",
    alt: "Exchange Futures tab with an expanded short futures position showing mark entry contract size margin P and L expiry delivery and close action",
    selector: ".stocks-pno",
    focusSelector: ".stocks-accordion-item.open",
    pad: 10,
    pre: async (page) => {
      await selectExchangeListing(page, "futures");
      await selectPnoTab(page, "Futures");
      await openFirstAccordion(page);
    },
  },
  {
    id: "history-tab",
    section: "history-tab",
    label: "Ledger",
    title: "Trade history ledger",
    text: "History records opens, adds, closes, covers, cash flow, realized P&L, and stop or take-profit tags when a trigger fires.",
    alt: "Exchange History tab showing tick action ticker quantity price cash flow and realized P and L columns",
    selector: ".stocks-pno",
    focusSelector: ".stocks-trades-list",
    pad: 10,
    pre: async (page) => {
      await selectPnoTab(page, "History");
    },
  },
  {
    id: "insights-tab",
    section: "insights-tab",
    label: "Insights",
    title: "Navigator market insights",
    text: "The Insights tab ranks trade ideas, edge, suggested limits, and blocked reasons when a navigator is aboard.",
    alt: "Exchange Insights tab showing ranked trade ideas with edge, suggested limit, status, and reason columns",
    selector: ".stocks-pno",
    focusSelector: ".stocks-insights-list",
    pad: 10,
    pre: async (page) => {
      await selectExchangeListing(page, "commodity");
      await selectPnoTab(page, "Insights");
    },
  },
  {
    id: "basis-underlying",
    section: "basis-pairs",
    label: "Basis",
    title: "Station basis listing",
    text: "Basis listings tie one station and one good together, exposing local price, spread versus universe spot, and local stock.",
    alt: "Exchange basis listing selected with underlying panel showing station, good, local price, spread versus spot, and local stock",
    selector: ".stocks-info-col",
    focusSelector: ".stocks-info-body > .stocks-info-row:nth-of-type(2)",
    pad: 10,
    maxHeight: 620,
    pre: async (page) => {
      await selectExchangeListing(page, "basis");
    },
  },
  {
    id: "index-underlying",
    section: "indices",
    label: "Index",
    title: "Sector and treasury indices",
    text: "Index listings summarize baskets such as sector commodities or overall station treasury health.",
    alt: "Exchange index listing selected with underlying panel showing sector basket member prices",
    selector: ".stocks-info-col",
    focusSelector: ".stocks-info-body > .stocks-info-row:nth-of-type(2)",
    pad: 10,
    maxHeight: 620,
    pre: async (page) => {
      await selectExchangeListing(page, "index");
    },
  },
];

const marketsShots = [
  {
    id: "screen-layout",
    section: "screen-layout",
    label: "Layout",
    title: "Markets split view",
    text: "Markets pairs the commodity browser with a detail column for spot history, logistics, quotes, producers, and consumers.",
    alt: "Markets screen showing commodity browser, universe spot chart, logistics metrics, best quotes, producers, and consumers",
    selector: ".markets-view .stocks-shell",
    focusSelector: ".markets-view .stocks-shell-right",
    pad: 10,
    maxHeight: 1040,
    pre: async (page) => {
      await selectMainTab(page, "Markets");
      await selectMarketsCategory(page, "Commodities");
    },
  },
  {
    id: "commodity-browser",
    section: "commodity-browser",
    label: "Browser",
    title: "Commodity browser",
    text: "Rows compare spot price, stock depth, best local ask, best local bid, and spread for every physical good.",
    alt: "Markets commodity browser showing spot price, stock depth, low ask, high bid, and spread columns",
    selector: ".markets-selector",
    focusSelector: ".markets-selector-list",
    pad: 10,
    pre: async (page) => {
      await selectMarketsCategory(page, "Commodities");
    },
  },
  {
    id: "category-tabs",
    section: "category-tabs",
    label: "Tabs",
    title: "Commodity category tabs",
    text: "Category tabs narrow the list to food, raw goods, parts, fuel, advanced goods, luxury goods, or upgrade modules.",
    alt: "Markets commodity category tabs with counts for commodities, food, raw, parts, fuel, advanced, luxury, and upgrades",
    selector: ".markets-selector",
    focusSelector: ".markets-tabs",
    pad: 10,
    maxHeight: 220,
    pre: async (page) => {
      await selectMarketsCategory(page, "Fuel");
    },
  },
  {
    id: "spot-chart",
    section: "spot-chart",
    label: "Spot",
    title: "Universe spot chart",
    text: "The detail column charts universe-wide spot history for the selected good with its base price as the reference line.",
    alt: "Markets universe spot chart for a selected commodity",
    selector: ".markets-view .stocks-info-col",
    focusSelector: ".markets-chart",
    pad: 10,
    maxHeight: 470,
    pre: async (page) => {
      await selectMarketsCategory(page, "Commodities");
    },
  },
  {
    id: "spot-and-logistics",
    section: "spot-and-logistics",
    label: "Signals",
    title: "Spot and logistics signals",
    text: "Spot explains price, base, stock health, and spread while Logistics compares active markets, production, consumption, and runway.",
    alt: "Markets spot and logistics KPI panels showing price, base, stock health, producers, consumers, net flow, and runway",
    selector: ".markets-view .stocks-info-col",
    focusSelector: ".markets-view .stocks-info-body > .stocks-info-row",
    pad: 10,
    maxHeight: 650,
  },
  {
    id: "best-quotes",
    section: "best-asks-and-best-bids",
    label: "Quotes",
    title: "Best asks and best bids",
    text: "The quote panels show where the cheapest supply and strongest demand are sitting right now.",
    alt: "Markets best asks and best bids panels listing station names, prices, stock, and target demand",
    selector: ".markets-view .stocks-info-body",
    focusSelector: ".markets-view .stocks-info-body .trade-helper-section:nth-of-type(2)",
    pad: 10,
    maxHeight: 740,
  },
  {
    id: "producers-consumers",
    section: "producers-and-consumers",
    label: "Flows",
    title: "Top producers and consumers",
    text: "Producer and consumer lists identify which stations create or absorb the selected good fastest.",
    alt: "Markets top producers and top consumers panels with station names and per tick rates",
    selector: ".markets-view .stocks-info-body",
    focusSelector: ".markets-view .stocks-info-body .trade-helper-section:nth-of-type(4)",
    pad: 10,
    maxHeight: 860,
  },
];

const atlasShots = [
  {
    id: "screen-layout",
    section: "screen-layout",
    label: "Layout",
    title: "Atlas map and detail layout",
    text: "Atlas keeps the sector map, station sheets, and selected station detail panel on one screen.",
    alt: "Atlas screen showing sector map, station sheet, and selected station detail panel",
    selector: ".atlas-view",
    focusSelector: ".atlas-detail-panel",
    pad: 10,
    maxHeight: 1060,
    pre: async (page) => {
      await selectMainTab(page, "Atlas");
      await selectAtlasMapTab(page, "Stations");
      await selectAtlasSheetTab(page, "Systems");
    },
  },
  {
    id: "map-modes",
    section: "map-modes",
    label: "Modes",
    title: "Station, syndicate, and logistics map modes",
    text: "Map modes switch the same sector from local station navigation to faction control or lane danger.",
    alt: "Atlas map panel with Stations, Syndicates, and Logistics map mode tabs",
    selector: ".atlas-map-panel",
    focusSelector: ".atlas-map-tabs",
    pad: 10,
    pre: async (page) => {
      await selectAtlasMapTab(page, "Logistics");
    },
  },
  {
    id: "systems-table",
    section: "systems-table",
    label: "Systems",
    title: "Systems table",
    text: "Systems rows compare station kind, traffic, jobs, market pressure, hires, upgrades, exchange signals, and route count.",
    alt: "Atlas systems table listing stations with kind, traffic, jobs, pressure, hires, upgrades, exchange, and routes",
    selector: ".atlas-sheet-panel",
    focusSelector: ".atlas-table-scroll",
    pad: 10,
    pre: async (page) => {
      await selectAtlasSheetTab(page, "Systems");
    },
  },
  {
    id: "ships-table",
    section: "ships-table",
    label: "Ships",
    title: "Ships table",
    text: "The Ships sheet locates player and NPC traffic with state, route, cargo, wallet, hull, and ETA context.",
    alt: "Atlas ships table listing ships with state, route, cargo, wallet, hull, and ETA",
    selector: ".atlas-sheet-panel",
    focusSelector: ".atlas-table-scroll",
    pad: 10,
    pre: async (page) => {
      await selectAtlasSheetTab(page, "Ships");
    },
  },
  {
    id: "station-detail",
    section: "station-detail",
    label: "Station",
    title: "Station detail panel",
    text: "The detail panel summarizes station profile, exchange context, local stock pressure, active events, traffic, and route actions.",
    alt: "Atlas station detail panel showing station profile, exchange context, market pressure, active events, and traffic",
    selector: ".atlas-detail-panel",
    pad: 10,
    maxHeight: 1040,
    pre: async (page) => {
      await selectAtlasSheetTab(page, "Systems");
    },
  },
  {
    id: "shipyards",
    section: "shipyards",
    label: "Shipyards",
    title: "Shipyard inventory",
    text: "Shipyards list blueprints with class, price, stats, pre-installed upgrades, traits, and buy eligibility.",
    alt: "Atlas shipyard inventory showing ship blueprints, class labels, prices, stats, upgrades, traits, and buy button",
    selector: ".atlas-detail-panel",
    focusSelector: ".atlas-shipyard-section",
    pad: 10,
    maxHeight: 1040,
    pre: async (page) => {
      await focusShipyard(page);
      await openFirstShipyardBlueprint(page);
    },
  },
  {
    id: "lane-danger-events",
    section: "lane-danger-and-events",
    label: "Danger",
    title: "Lane danger and active events",
    text: "Logistics mode tints recent danger lanes while the Events sheet lists active news that is moving the economy.",
    alt: "Atlas logistics map with lane danger and active news events list",
    selector: ".atlas-view",
    focusSelector: ".atlas-news-list",
    pad: 10,
    maxHeight: 1060,
    pre: async (page) => {
      await selectAtlasMapTab(page, "Logistics");
      await selectAtlasSheetTab(page, "Events");
    },
  },
];

const ledgerShots = [
  {
    id: "screen-layout",
    section: "screen-layout",
    label: "Layout",
    title: "Ledger records and sidebar",
    text: "Ledger keeps career records on the left and the Captain's Ledger summary on the right.",
    alt: "Ledger screen showing record tabs and Captain's Ledger sidebar",
    selector: ".charters-view",
    focusSelector: ".charters-sidebar-card",
    pad: 10,
    maxHeight: 1040,
    pre: async (page) => {
      await selectMainTab(page, "Ledger");
      await selectLedgerTab(page, "Charters");
    },
  },
  {
    id: "charters",
    section: "charters",
    label: "Charters",
    title: "Charters and tier licenses",
    text: "Charters turn manual actions into crew-guild unlocks and upgrade-tier licenses.",
    alt: "Ledger Charters tab showing crew guilds and tier license milestones",
    selector: ".charters-badges-card",
    focusSelector: ".charters-badges-grid",
    pad: 10,
    pre: async (page) => {
      await selectLedgerTab(page, "Charters");
    },
  },
  {
    id: "syndicates",
    section: "syndicates",
    label: "Syndicates",
    title: "Syndicate reputation",
    text: "The Syndicates tab shows faction traits, alignment, reputation bands, and toll-discount context.",
    alt: "Ledger Syndicates tab showing faction reputation cards and reputation bands",
    selector: ".charters-badges-card",
    focusSelector: ".syndicate-rep-grid",
    pad: 10,
    pre: async (page) => {
      await selectLedgerTab(page, "Syndicates");
    },
  },
  {
    id: "combat",
    section: "combat",
    label: "Combat",
    title: "Combat encounter history",
    text: "The Combat tab records hostile contacts, player choices, outcomes, routes, and losses.",
    alt: "Ledger Combat tab showing hostile encounter history with choices, outcomes, routes, and losses",
    selector: ".charters-badges-card",
    focusSelector: ".ledger-log-list",
    pad: 10,
    pre: async (page) => {
      await selectLedgerTab(page, "Combat");
    },
  },
  {
    id: "log",
    section: "log",
    label: "Log",
    title: "Fleet activity log",
    text: "The Log tab merges cargo operations, travel, contracts, and exchange trades from the selected fleet.",
    alt: "Ledger Log tab showing fleet cargo, travel, contract, and exchange trade entries",
    selector: ".charters-badges-card",
    focusSelector: ".ledger-log-list",
    pad: 10,
    pre: async (page) => {
      await selectLedgerTab(page, "Log");
    },
  },
  {
    id: "captain-ledger",
    section: "captain-s-ledger",
    label: "Sidebar",
    title: "Captain's Ledger sidebar",
    text: "The sidebar summarizes manual actions, earned charters, fleet wallet, ship count, and universe backstory.",
    alt: "Captain's Ledger sidebar showing career progress, wallet, ship count, save context, and backstory",
    selector: ".charters-sidebar-card",
    focusSelector: ".charters-ledger-head",
    pad: 10,
    pre: async (page) => {
      await selectLedgerTab(page, "Charters");
    },
  },
];

const combatShots = [
  {
    id: "encounter-modal",
    section: "encounter-modal",
    label: "Encounter",
    title: "Pending encounter modal",
    text: "Manual ships pause on the encounter modal until the player chooses fight, flee, or bribe.",
    alt: "Combat encounter modal showing the player ship, attacking pirate, route, and available choices",
    selector: ".ui-modal-dialog.encounter-dialog",
    focusSelector: ".encounter-stats",
    pad: 10,
    pre: async (page) => {
      await showCombatEncounterModal(page);
    },
  },
  {
    id: "choices-and-odds",
    section: "choices-and-odds",
    label: "Choices",
    title: "Fight, flee, and bribe cards",
    text: "Each action shows a fuzzy odds band and marks the auto-pilot recommendation when one choice is clearly favored.",
    alt: "Encounter action cards showing Fight, Flee, and Bribe with odds bands and a recommended action",
    selector: ".encounter-actions",
    focusSelector: ".encounter-action.recommended",
    pad: 10,
    pre: async (page) => {
      await showCombatEncounterModal(page);
    },
  },
  {
    id: "losses",
    section: "losses",
    label: "Losses",
    title: "Concrete loss pills",
    text: "Loss pills name the exact cargo, credits, or hull damage at stake before the player commits.",
    alt: "Encounter action cards showing cargo, credit, and hull loss pills",
    selector: ".encounter-actions",
    focusSelector: ".encounter-action-pills",
    pad: 10,
    pre: async (page) => {
      await showCombatEncounterModal(page);
    },
  },
  {
    id: "ledger-history",
    section: "ledger-and-atlas-history",
    label: "Ledger",
    title: "Combat history feed",
    text: "Ledger records encounter choices, outcomes, attackers, routes, and losses for player ships or all ships.",
    alt: "Ledger Combat tab showing encounter history with choices, outcomes, attackers, routes, and losses",
    selector: ".charters-badges-card",
    focusSelector: ".ledger-log-list",
    pad: 10,
    pre: async (page) => {
      await clearCombatEncounterModal(page);
      await selectMainTab(page, "Ledger");
      await selectLedgerTab(page, "Combat");
    },
  },
  {
    id: "atlas-danger",
    section: "ledger-and-atlas-history",
    label: "Atlas",
    title: "Lane danger and encounter pings",
    text: "Atlas Logistics mode turns recent encounter history into lane danger tint and fresh hostile-contact pings.",
    alt: "Atlas Logistics map showing lane danger, encounter pings, and active security news",
    selector: ".atlas-view",
    focusSelector: ".atlas-map-panel",
    pad: 10,
    maxHeight: 1060,
    pre: async (page) => {
      await clearCombatEncounterModal(page);
      await selectMainTab(page, "Atlas");
      await selectAtlasMapTab(page, "Logistics");
      await selectAtlasSheetTab(page, "Events");
    },
  },
];

const siteShots = [
  {
    id: "cargo",
    section: "site",
    label: "Cargo",
    title: "Cargo UI",
    text: "Homepage carousel screenshot for Cargo operations.",
    alt: "Ledgway Cargo UI showing ship operations, station markets, and travel controls",
    selector: ".app",
    pad: 0,
    maxHeight: DEFAULT_VIEWPORT.height,
    pre: async (page) => {
      await selectMainTab(page, "Cargo");
      await selectShipTab(page, "Cargo");
      await selectExchangeTab(page, "Markets");
      await clearInfoFocus(page);
    },
  },
  {
    id: "exchange",
    section: "site",
    label: "Exchange",
    title: "Exchange UI",
    text: "Homepage carousel screenshot for the market desk.",
    alt: "Ledgway Exchange UI showing asset listings, positions, market detail, chart, order book, and order form",
    selector: ".app",
    pad: 0,
    maxHeight: DEFAULT_VIEWPORT.height,
    pre: async (page) => {
      await selectMainTab(page, "Exchange");
      await selectExchangeListing(page, "commodity");
      await selectPnoTab(page, "Positions");
    },
  },
  {
    id: "markets",
    section: "site",
    label: "Markets",
    title: "Markets UI",
    text: "Homepage carousel screenshot for commodity logistics.",
    alt: "Ledgway Markets UI showing commodity listings, universe spot chart, logistics, quotes, producers, and consumers",
    selector: ".app",
    pad: 0,
    maxHeight: DEFAULT_VIEWPORT.height,
    pre: async (page) => {
      await selectMainTab(page, "Markets");
      await selectMarketsCategory(page, "Commodities");
    },
  },
  {
    id: "atlas",
    section: "site",
    label: "Atlas",
    title: "Atlas UI",
    text: "Homepage carousel screenshot for the sector map.",
    alt: "Ledgway Atlas UI showing sector map, systems table, station detail, shipyard inventory, and lane context",
    selector: ".app",
    pad: 0,
    maxHeight: DEFAULT_VIEWPORT.height,
    pre: async (page) => {
      await selectMainTab(page, "Atlas");
      await focusShipyard(page);
      await openFirstShipyardBlueprint(page);
    },
  },
  {
    id: "ledger",
    section: "site",
    label: "Ledger",
    title: "Ledger UI",
    text: "Homepage carousel screenshot for career records.",
    alt: "Ledgway Ledger UI showing charters, syndicates, combat, fleet log, and Captain's Ledger summary",
    selector: ".app",
    pad: 0,
    maxHeight: DEFAULT_VIEWPORT.height,
    pre: async (page) => {
      await selectMainTab(page, "Ledger");
      await selectLedgerTab(page, "Combat");
    },
  },
];

const readmeFullShots = [
  {
    id: "fleet-full",
    section: "readme",
    label: "Cargo",
    title: "Full Cargo UI",
    text: "Full-viewport Cargo operations screen for README composition.",
    alt: "Full Ledgway UI showing Cargo ship operations, station travel, dockside markets, and ship context",
    selector: ".app",
    pad: 0,
    maxHeight: DEFAULT_VIEWPORT.height,
    pre: async (page) => {
      await page.evaluate(() => {
        const useStore = window.__LEDGWAY_CAPTURE_STORE__;
        if (!useStore) return;
        const state = useStore.getState();
        useStore.setState({
          selectedTab: "player",
          stockGuideEnabled: false,
          speed: 0,
          lastError: null,
          tickEpoch: state.tickEpoch + 1,
        });
      });
      await closeGameMenu(page);
      await page.waitForSelector(".player-view");
      await selectShipTab(page, "Cargo");
      await selectExchangeTab(page, "Markets");
      await clearInfoFocus(page);
      await page.wait(350);
    },
  },
  {
    id: "exchange-full",
    section: "readme",
    label: "Exchange",
    title: "Full Exchange UI",
    text: "Full-viewport Exchange market desk for README composition.",
    alt: "Full Ledgway UI showing the Exchange listing browser, positions, market detail, order book, tape, and order form",
    selector: ".app",
    pad: 0,
    maxHeight: DEFAULT_VIEWPORT.height,
    pre: async (page) => {
      await enrichExchangeDeveloperState(page);
      await closeGameMenu(page);
      await selectExchangeListing(page, "commodity");
      await selectPnoTab(page, "Positions");
      await page.wait(350);
    },
  },
];

const shotSets = {
  "my-fleet": myFleetShots,
  exchange: exchangeShots,
  markets: marketsShots,
  atlas: atlasShots,
  combat: combatShots,
  ledger: ledgerShots,
  site: siteShots,
  "readme-full": readmeFullShots,
};

const shots = shotSets[captureView];

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const port = await findFreePort();
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "ledgway-capture-"));
  const chromePath = findChromePath();
  const chrome = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--window-size=${DEFAULT_VIEWPORT.width},${DEFAULT_VIEWPORT.height}`,
    "about:blank",
  ], { stdio: "ignore" });

  let page;
  try {
    await waitForBrowser(port);
    const target = await openPageTarget(port);
    page = await CdpPage.open(target.webSocketDebuggerUrl);
    await page.enable();
    await page.setViewport(DEFAULT_VIEWPORT);
    await page.navigate(targetUrl);
    await page.waitForSelector(".player-view");
    await installCaptureStyle(page);
    await loadDeveloperState(page);
    await prepareCaptureView(page, captureView);

    await mkdir(outDir, { recursive: true });
    const manifest = [];
    for (const shot of shots) {
      console.log(`capturing ${shot.id}`);
      const entry = await captureShot(page, shot);
      manifest.push(entry);
    }

    if (captureView !== "site") {
      const manifestPath = path.join(outDir, "manifest.json");
      await writeFile(manifestPath, `${JSON.stringify({ url: targetUrl, generatedAt: new Date().toISOString(), shots: manifest }, null, 2)}\n`);
    }
    console.log(`wrote ${manifest.length} screenshots to ${path.relative(process.cwd(), outDir)}`);
  } finally {
    if (page) page.close();
    if (!keepBrowser) {
      await stopChrome(chrome);
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function captureShot(page, shot) {
  await setSuggestionOverlays(page, shot.showSuggestions === true);
  if (shot.pre) await shot.pre(page);
  await page.waitForSelector(shot.selector);
  await scrollIntoView(page, shot.selector);
  await page.wait(120);

  const clip = await clipForSelector(page, shot.selector, shot.pad ?? 8, shot.maxHeight);
  const focus = shot.focusSelector
    ? await focusForSelector(page, shot.focusSelector, clip)
    : undefined;

  const filename = `${shot.id}.png`;
  const absolutePath = path.join(outDir, filename);
  await page.capturePng(absolutePath, clip);

  return {
    id: shot.id,
    section: shot.section,
    image: publicPath(absolutePath),
    alt: shot.alt,
    label: shot.label,
    title: shot.title,
    text: shot.text,
    focus,
  };
}

async function loadDeveloperState(page) {
  const result = await page.evaluate(() => {
    const useStore = window.__LEDGWAY_CAPTURE_STORE__;
    if (!useStore) return { ok: false, reason: "capture store hook unavailable" };
    useStore.getState().loadDeveloperState();
    useStore.setState({ pendingNewGame: null, pendingSeed: null, pendingWorldLoad: false });
    return { ok: true };
  });
  if (!result?.ok) throw new Error(`Could not load developer state: ${result?.reason ?? "unknown"}`);
  await page.waitForSelector(".topbar-view-tabs");
  await page.waitForSelector(".crew-card-grid, .ship-card");
  await page.wait(250);
}

async function prepareCaptureView(page, view) {
  if (view === "exchange") {
    await enrichExchangeDeveloperState(page);
    return;
  }
  if (view === "markets") {
    await enrichMarketsDeveloperState(page);
    return;
  }
  if (view === "atlas") {
    await enrichAtlasDeveloperState(page);
    return;
  }
  if (view === "combat") {
    await enrichCombatDeveloperState(page);
    return;
  }
  if (view === "ledger") {
    await enrichLedgerDeveloperState(page);
    return;
  }
  if (view === "site") {
    await enrichSiteDeveloperState(page);
    return;
  }
  await enrichMyFleetDeveloperState(page);
}

async function enrichMyFleetDeveloperState(page) {
  const result = await page.evaluate(async () => {
    const useStore = window.__LEDGWAY_CAPTURE_STORE__;
    if (!useStore) return { ok: false, reason: "capture store hook unavailable" };
    const state = useStore.getState();
    const world = state.world;
    const shipId = world.player?.shipIds[0];
    if (!shipId) return { ok: false, reason: "missing player ship" };
    const ship = world.traders[shipId];
    if (!ship) return { ok: false, reason: "missing ship" };

    let locId = ship.location;
    if (world.locations[locId]?.traits?.tags?.includes("shipyard")) {
      locId = Object.values(world.locations).find(candidate => !candidate.traits.tags.includes("shipyard"))?.id ?? locId;
      ship.location = locId;
    }
    const loc = world.locations[locId];
    const market = world.markets[locId];
    const routeIds = Object.keys(world.lanes[locId] ?? {});
    const firstRoute = routeIds[0] ?? locId;
    const secondRoute = routeIds[1] ?? firstRoute;

    ship.name = "Voyager";
    ship.state = "idle";
    ship.destination = null;
    ship.ticksRemaining = 0;
    ship.pilot = "manual";
    ship.funds = 188_420;
    ship.crew = {
      ...(ship.crew ?? {}),
      captain: ship.crew?.captain ?? crewMember("captain", "Vera Pike", 2, { speedBonus: 0.5 }),
      navigator: ship.crew?.navigator ?? crewMember("navigator", "Jun Sato", 2, { rangeEfficiency: 0.12, treasuryYield: 0.0005 }),
      mechanic: ship.crew?.mechanic ?? crewMember("mechanic", "Mara Coil", 2, { maintenanceDiscount: 0.35, unloadSpeedBonus: 0.5 }),
      mercenary: ship.crew?.mercenary ?? crewMember("mercenary", "Ilya Knox", 2, { weaponPowerBonus: 3, hullBonus: 2 }),
    };
    ship.currentFuel = { good: "plasma", qty: Math.max(18, Math.floor(ship.fuelCapacity * 0.28)) };
    ship.maintenanceDebt = 2_350;
    ship.cargo = [
      { good: "polymer", qty: 32, source: secondRoute, unitPrice: 7.4, purchasedAt: world.tick - 34 },
      { good: "parts", qty: 14, source: firstRoute, unitPrice: 95.5, purchasedAt: world.tick - 18 },
      { good: "upg_engine_micro_2", qty: 1, source: locId, unitPrice: 7_850, purchasedAt: world.tick - 5 },
      { good: "upg_cargo_loader_2", qty: 1, source: locId, unitPrice: 5_100, purchasedAt: world.tick - 4 },
    ];
    ship.unloadingCargo = [
      { good: "protein", qty: 10, source: firstRoute, unitPrice: 5.8, purchasedAt: world.tick - 11, unloadTicksRemaining: 2 },
    ];
    ship.log = [
      { tick: world.tick - 18, kind: "buy", message: "Loaded 14 Machine Parts at Spring Bloom.", tone: "info" },
      { tick: world.tick - 8, kind: "depart", message: "Departed South Haven Hub for Far Plaza Hub.", tone: "info" },
      { tick: world.tick - 2, kind: "sell", message: "Sold 10 Cultured Protein into the local market.", tone: "good" },
    ];

    if (market) {
      market.stock.polymer = Math.max(market.stock.polymer ?? 0, 85);
      market.stock.parts = Math.max(market.stock.parts ?? 0, 12);
      market.stock.protein = Math.max(market.stock.protein ?? 0, 240);
      market.stock.plasma = Math.max(market.stock.plasma ?? 0, 180);
      market.stock.upg_engine_micro_2 = Math.max(market.stock.upg_engine_micro_2 ?? 0, 2);
      market.stock.upg_cargo_loader_2 = Math.max(market.stock.upg_cargo_loader_2 ?? 0, 2);
      market.stock.upg_fuel_aux_2 = Math.max(market.stock.upg_fuel_aux_2 ?? 0, 1);
      market.prices.polymer = 10.1;
      market.prices.parts = 130.8;
      market.prices.protein = 6.7;
      market.prices.plasma = 11.5;
    }

    const addJob = (job) => {
      delete world.jobs[job.id];
      world.jobs[job.id] = job;
    };
    addJob({
      id: "wiki-open-parts",
      kind: "shortage",
      tier: "high",
      good: "parts",
      qty: 18,
      destination: locId,
      reward: 8_600,
      penalty: 8_600,
      postedTick: world.tick - 4,
      expiresAt: world.tick + 22,
      acceptedBy: null,
      delivered: 0,
    });
    addJob({
      id: "wiki-open-plasma",
      kind: "rescue",
      tier: "medium",
      good: "plasma",
      qty: 24,
      destination: locId,
      reward: 2_900,
      penalty: 725,
      postedTick: world.tick - 9,
      expiresAt: world.tick + 38,
      acceptedBy: null,
      delivered: 0,
      rescueTarget: Object.keys(world.traders).find((id) => id !== shipId),
    });
    addJob({
      id: "wiki-active-polymer",
      kind: "shortage",
      tier: "medium",
      good: "polymer",
      qty: 40,
      destination: firstRoute,
      reward: 4_800,
      penalty: 1_200,
      postedTick: world.tick - 12,
      expiresAt: world.tick + 48,
      acceptedBy: shipId,
      delivered: 10,
    });
    addJob({
      id: "wiki-active-parts",
      kind: "shortage",
      tier: "low",
      good: "parts",
      qty: 12,
      destination: secondRoute,
      reward: 2_100,
      penalty: 0,
      postedTick: world.tick - 7,
      expiresAt: world.tick + 88,
      acceptedBy: shipId,
      delivered: 3,
    });

    if (loc) {
      loc.targetStock.parts = Math.max(loc.targetStock.parts ?? 0, 80);
      loc.targetStock.polymer = Math.max(loc.targetStock.polymer ?? 0, 120);
      loc.consumes = [
        ...loc.consumes.filter((entry) => entry.good !== "parts"),
        { good: "parts", ratePerTick: 1.8 },
      ];
    }

    useStore.setState({
      world,
      speed: 0,
      selectedTab: "player",
      selectedTrader: shipId,
      selectedLocation: locId,
      selectedGood: null,
      saveStatus: "saved",
      lastError: null,
      tickEpoch: state.tickEpoch + 1,
    });
    return {
      ok: true,
      shipId,
      cargoLots: ship.cargo.length,
      unloadingLots: ship.unloadingCargo?.length ?? 0,
      jobs: Object.keys(world.jobs).length,
    };

    function crewMember(role, name, tier, modifiers) {
      return {
        id: `wiki-${role}`,
        role,
        name,
        tier,
        hireCost: 0,
        wagePerTick: role === "captain" ? 140 : role === "mercenary" ? 180 : 75,
        modifiers,
        sex: "nonbinary",
        age: "adult",
        race: "human",
      };
    }
  });
  if (!result?.ok) throw new Error(`Could not enrich developer state: ${result?.reason ?? "unknown"}`);
  console.log(`prepared dev state: ${result.cargoLots} cargo lots, ${result.unloadingLots} unloading lots, ${result.jobs} jobs`);
  await selectShipTab(page, "Cargo");
  await page.waitForSelector(".cargo-row");
  await page.wait(250);
}

async function enrichExchangeDeveloperState(page) {
  const result = await page.evaluate(async () => {
    const useStore = window.__LEDGWAY_CAPTURE_STORE__;
    if (!useStore) return { ok: false, reason: "capture store hook unavailable" };
    const state = useStore.getState();
    const world = state.world;
    const player = world.player;
    const shipId = player?.shipIds?.[0];
    if (!player || !shipId) return { ok: false, reason: "missing player" };
    const ship = world.traders[shipId];
    if (!ship) return { ok: false, reason: "missing player ship" };

    const equities = () => Object.values(world.equities ?? {});
    if (equities().length === 0) return { ok: false, reason: "stock market has no listings" };

    world.tick = Math.max(world.tick ?? 0, 260);
    ship.name = "Voyager";
    ship.state = "idle";
    ship.destination = null;
    ship.ticksRemaining = 0;
    ship.pilot = "manual";
    ship.funds = 642_500;
    ship.maintenanceDebt = 0;

    const contracts = Object.values(world.contracts ?? {});
    let futureContract = contracts.find(c => c.goodId === "plasma" && c.expiryTick > world.tick + 80)
      ?? contracts.find(c => c.goodId === "electronics" && c.expiryTick > world.tick + 80)
      ?? contracts.find(c => c.expiryTick > world.tick + 80)
      ?? contracts[0];
    if (futureContract && futureContract.expiryTick <= world.tick + 80) {
      futureContract.expiryTick = world.tick + 520;
    }
    if (futureContract?.deliveryStation && world.locations[futureContract.deliveryStation]) {
      ship.location = futureContract.deliveryStation;
    }
    const locId = ship.location;

    const stationEq = equities().find(eq => eq.kind === "station" && eq.underlyingId === locId)
      ?? equities().find(eq => eq.kind === "station");
    const commodityEq = futureContract
      ? equities().find(eq => eq.kind === "commodity" && eq.underlyingId === futureContract.goodId)
        ?? equities().find(eq => eq.kind === "commodity")
      : equities().find(eq => eq.kind === "commodity");
    const basisEq = equities().find(eq => eq.kind === "basis" && eq.underlyingId.startsWith(`${locId}::`))
      ?? equities().find(eq => eq.kind === "basis");
    const futuresEq = futureContract ? world.equities[futureContract.id] : equities().find(eq => eq.kind === "futures");
    const syndicateEq = equities().find(eq => eq.kind === "syndicate");
    const indexEq = equities().find(eq => eq.kind === "index" && eq.id !== "eq_idx_tin")
      ?? equities().find(eq => eq.kind === "index");

    const required = { station: stationEq, commodity: commodityEq, basis: basisEq, futures: futuresEq, syndicate: syndicateEq, index: indexEq };
    const missing = Object.entries(required).filter(([, eq]) => !eq).map(([kind]) => kind);
    if (missing.length > 0) return { ok: false, reason: `missing listings: ${missing.join(", ")}` };

    const selectedEqs = [stationEq, commodityEq, basisEq, futuresEq, syndicateEq, indexEq].filter(Boolean);
    const npcIds = Object.keys(world.traders).filter(id => id !== shipId);

    if (stationEq) {
      const market = world.markets[stationEq.underlyingId];
      if (market) {
        market.treasuryTarget = Math.max(market.treasuryTarget ?? 0, 180_000);
        market.treasury = Math.max(market.treasury ?? 0, market.treasuryTarget * 1.36);
        market.netTradeFlow = Math.max(market.netTradeFlow ?? 0, market.treasuryTarget * 0.28);
      }
    }

    if (basisEq) {
      const parts = parseBasis(basisEq.underlyingId);
      const market = parts ? world.markets[parts.locationId] : null;
      const good = parts ? world.goods[parts.goodId] : null;
      if (market && good) {
        market.stock[good.id] = Math.max(market.stock[good.id] ?? 0, 420);
        market.prices[good.id] = Math.max(1, good.basePrice * 1.34);
      }
    }

    for (const eq of selectedEqs) {
      const drift =
        eq.kind === "commodity" ? 1.18 :
        eq.kind === "basis" ? 1.31 :
        eq.kind === "futures" ? 1.11 :
        eq.kind === "index" ? 1.07 :
        eq.kind === "syndicate" ? 0.92 :
        1.04;
      seedHistory(eq, drift);
      seedTrades(eq, 46);
      seedBook(eq);
    }

    const positions = {};
    const reservedShares = {};
    const trades = [];
    const futures = {};
    const reservedFutures = {};
    player.positions = positions;
    player.reservedShares = reservedShares;
    player.trades = trades;
    player.futures = futures;
    player.reservedFutures = reservedFutures;
    ship.stockPositions = positions;
    ship.reservedShares = reservedShares;
    ship.stockTrades = trades;
    ship.futures = futures;
    ship.reservedFutures = reservedFutures;

    if (commodityEq) {
      positions[commodityEq.id] = {
        equityId: commodityEq.id,
        kind: "long",
        shares: 86,
        avgEntryPrice: roundPrice(commodityEq.price * 0.86),
        openedAt: world.tick - 96,
        stopLoss: roundPrice(commodityEq.price * 0.93),
        takeProfit: roundPrice(commodityEq.price * 1.14),
      };
    }
    if (syndicateEq) {
      positions[syndicateEq.id] = {
        equityId: syndicateEq.id,
        kind: "short",
        shares: 44,
        avgEntryPrice: roundPrice(syndicateEq.price * 1.12),
        openedAt: world.tick - 72,
        stopLoss: roundPrice(syndicateEq.price * 1.09),
        takeProfit: roundPrice(syndicateEq.price * 0.91),
      };
      const synd = world.syndicates[syndicateEq.underlyingId];
      if (synd) {
        synd.treasury = Math.max(synd.treasury ?? 0, 118_000);
        synd.recentRevenue = Math.max(synd.recentRevenue ?? 0, 24_600);
      }
    }
    if (stationEq) {
      positions[stationEq.id] = {
        equityId: stationEq.id,
        kind: "long",
        shares: 38,
        avgEntryPrice: roundPrice(stationEq.price * 1.04),
        openedAt: world.tick - 31,
        stopLoss: roundPrice(stationEq.price * 0.94),
        takeProfit: roundPrice(stationEq.price * 1.09),
      };
    }

    if (futureContract && futuresEq) {
      const spot = world.equities[futureContract.underlyingEquityId]?.price ?? futuresEq.price;
      const contractsHeld = 2;
      const margin = futureContract.marginFraction * futureContract.contractSize * spot * contractsHeld;
      futures[futuresEq.id] = {
        contractId: futuresEq.id,
        side: "short",
        contracts: contractsHeld,
        avgEntryPrice: roundPrice(spot * 1.05),
        marginPosted: margin,
        openedAt: world.tick - 44,
        lastMarkPrice: spot,
      };
      reservedFutures[futuresEq.id] = margin;
      futureContract.openInterest = Math.max(futureContract.openInterest ?? 0, 17);
      const deliveryQty = futureContract.contractSize * contractsHeld;
      ship.cargo = [
        {
          good: futureContract.goodId,
          qty: deliveryQty,
          source: futureContract.deliveryStation,
          unitPrice: roundPrice(spot * 0.82),
          purchasedAt: world.tick - 58,
        },
        ...ship.cargo.filter(lot => lot.good !== futureContract.goodId).slice(0, 3),
      ];
    }

    if (commodityEq) {
      addPlayerOrder(commodityEq, "ask", 24, commodityEq.price * 1.055, 17);
      reservedShares[commodityEq.id] = (reservedShares[commodityEq.id] ?? 0) + 24;
    }
    if (stationEq) {
      addPlayerOrder(stationEq, "bid", 35, stationEq.price * 0.965, 11);
    }
    if (basisEq) {
      addPlayerOrder(basisEq, "bid", 18, basisEq.price * 0.978, 6);
    }

    addTrade(commodityEq, "open_long", 72, commodityEq.price * 0.86, -(72 * commodityEq.price * 0.86 * 1.01));
    addTrade(commodityEq, "add_long", 14, commodityEq.price * 0.91, -(14 * commodityEq.price * 0.91 * 1.01));
    addTrade(stationEq, "open_long", 48, stationEq.price * 1.04, -(48 * stationEq.price * 1.04 * 1.01));
    addTrade(stationEq, "close_long", 10, stationEq.price * 0.99, 10 * stationEq.price * 0.99 * 0.99, -Math.abs(10 * stationEq.price * 0.05), "stop_loss");
    addTrade(syndicateEq, "open_short", 44, syndicateEq.price * 1.12, 44 * syndicateEq.price * 1.12 * 0.99);
    addTrade(syndicateEq, "cover_short", 8, syndicateEq.price * 0.95, -(8 * syndicateEq.price * 0.95 * 1.01), Math.abs(8 * syndicateEq.price * 0.17), "take_profit");

    const ids = {
      station: stationEq?.id,
      commodity: commodityEq?.id,
      basis: basisEq?.id,
      futures: futuresEq?.id,
      syndicate: syndicateEq?.id,
      index: indexEq?.id,
    };
    window.__LEDGWAY_CAPTURE_EXCHANGE_IDS__ = ids;

    useStore.setState({
      world,
      speed: 0,
      selectedTab: "stocks",
      selectedTrader: shipId,
      selectedEquity: commodityEq?.id ?? futuresEq?.id ?? stationEq?.id ?? null,
      saveStatus: "saved",
      lastError: null,
      tickEpoch: state.tickEpoch + 1,
    });

    return {
      ok: true,
      ids,
      positions: Object.keys(player.positions).length,
      orders: countPlayerOrders(shipId),
      futures: Object.keys(futures).length,
      trades: trades.length,
    };

    function parseBasis(underlyingId) {
      const idx = underlyingId.indexOf("::");
      if (idx < 0) return null;
      return { locationId: underlyingId.slice(0, idx), goodId: underlyingId.slice(idx + 2) };
    }

    function clampPrice(eq, price) {
      const floor = (eq.anchorPrice || 1) * 0.1;
      const ceiling = (eq.anchorPrice || 1) * 10;
      return Math.max(floor, Math.min(ceiling, price));
    }

    function roundPrice(price) {
      return Math.max(0.01, Math.round(price * 100) / 100);
    }

    function seedHistory(eq, drift) {
      const startTick = Math.max(0, world.tick - 149);
      const base = Math.max(1, eq.anchorPrice || eq.price || 10);
      const points = [];
      for (let i = 0; i < 150; i++) {
        const progress = i / 149;
        const wave = Math.sin(i * 0.31 + eq.id.length) * 0.025 + Math.cos(i * 0.11) * 0.012;
        const price = clampPrice(eq, base * (1 + (drift - 1) * progress) * (1 + wave));
        points.push({ tick: startTick + i, price: roundPrice(price) });
      }
      eq.history = points;
      eq.prevPrice = points[points.length - 2]?.price ?? points[0].price;
      eq.price = points[points.length - 1].price;
      eq.lastDividend = eq.kind === "station" || eq.kind === "syndicate"
        ? { tick: world.tick - 41, perShare: roundPrice(eq.price * 0.006) }
        : eq.lastDividend;
    }

    function seedTrades(eq, count) {
      const trades = [];
      const baseTick = Math.max(1, world.tick - count);
      for (let i = 0; i < count; i++) {
        const side = i % 4 === 0 ? "ask" : "bid";
        const price = roundPrice(eq.price * (1 + Math.sin(i * 0.43) * 0.011 + (side === "bid" ? 0.002 : -0.002)));
        trades.push({
          equityId: eq.id,
          qty: 9 + ((i * 13) % 58),
          price,
          buyer: side === "bid" ? (npcIds[i % Math.max(1, npcIds.length)] ?? "synthetic-mm") : "synthetic-mm",
          seller: side === "bid" ? "synthetic-mm" : (npcIds[(i + 2) % Math.max(1, npcIds.length)] ?? "synthetic-mm"),
          takerSide: side,
          tick: baseTick + i,
        });
      }
      eq.recentTrades = trades;
    }

    function seedBook(eq) {
      world.orderBooks = world.orderBooks ?? {};
      const book = { equityId: eq.id, bids: [], asks: [] };
      const center = Math.max(0.01, eq.price);
      for (let i = 0; i < 8; i++) {
        const agentId = npcIds[i % Math.max(1, npcIds.length)] ?? "synthetic-mm";
        const step = 0.008 + i * 0.0065;
        book.bids.push({
          id: `wiki_${eq.id}_bid_${i}`,
          equityId: eq.id,
          side: "bid",
          qty: 42 + i * 18 + ((i * 7) % 13),
          limitPrice: roundPrice(center * (1 - step)),
          agentId,
          postedAt: world.tick - 30 + i,
          ttl: 14,
        });
        book.asks.push({
          id: `wiki_${eq.id}_ask_${i}`,
          equityId: eq.id,
          side: "ask",
          qty: 38 + i * 16 + ((i * 5) % 17),
          limitPrice: roundPrice(center * (1 + step)),
          agentId,
          postedAt: world.tick - 29 + i,
          ttl: 14,
        });
      }
      world.orderBooks[eq.id] = book;
      sortBook(book);
    }

    function addPlayerOrder(eq, side, qty, price, age) {
      const book = world.orderBooks?.[eq.id];
      if (!book) return;
      const order = {
        id: `wiki_player_${eq.id}_${side}`,
        equityId: eq.id,
        side,
        qty,
        limitPrice: roundPrice(price),
        agentId: shipId,
        postedAt: Math.max(0, world.tick - age),
      };
      if (side === "bid") book.bids.push(order);
      else book.asks.push(order);
      sortBook(book);
    }

    function sortBook(book) {
      book.bids.sort((a, b) => b.limitPrice - a.limitPrice || a.postedAt - b.postedAt || a.id.localeCompare(b.id));
      book.asks.sort((a, b) => a.limitPrice - b.limitPrice || a.postedAt - b.postedAt || a.id.localeCompare(b.id));
    }

    function addTrade(eq, action, shares, price, cashFlow, realizedPnl, trigger) {
      if (!eq) return;
      trades.push({
        id: `wiki_tr_${trades.length + 1}`,
        tick: Math.max(0, world.tick - 90 + trades.length * 9),
        equityId: eq.id,
        ticker: eq.ticker,
        action,
        shares,
        price: roundPrice(price),
        fee: Math.abs(shares * price * 0.01),
        cashFlow,
        realizedPnl,
        trigger,
      });
    }

    function countPlayerOrders(activeShipId) {
      let total = 0;
      for (const book of Object.values(world.orderBooks ?? {})) {
        total += [...book.bids, ...book.asks].filter(order => order.agentId === activeShipId).length;
      }
      return total;
    }
  });

  if (!result?.ok) throw new Error(`Could not enrich exchange developer state: ${result?.reason ?? "unknown"}`);
  console.log(`prepared exchange state: ${result.positions} positions, ${result.orders} orders, ${result.futures} futures, ${result.trades} trades`);
  await page.waitForSelector(".stocks-view");
  await page.waitForSelector(".stocks-info-col");
  await page.wait(450);
}

async function enrichMarketsDeveloperState(page) {
  const result = await page.evaluate(() => {
    const useStore = window.__LEDGWAY_CAPTURE_STORE__;
    if (!useStore) return { ok: false, reason: "capture store hook unavailable" };
    const state = useStore.getState();
    const world = state.world;
    const goods = Object.values(world.goods ?? {}).filter(g => g.category !== "upgrade");
    const focusGood = world.goods.plasma?.id
      ?? goods.find(g => g.category === "fuel")?.id
      ?? goods[0]?.id;
    if (!focusGood) return { ok: false, reason: "no commodity goods" };
    const base = world.goods[focusGood]?.basePrice ?? 10;
    const locations = Object.values(world.locations ?? {});
    if (locations.length === 0) return { ok: false, reason: "no locations" };
    world.tick = Math.max(world.tick ?? 0, 420);

    for (let i = 0; i < locations.length; i++) {
      const loc = locations[i];
      const market = world.markets[loc.id];
      if (!market) continue;
      loc.targetStock[focusGood] = Math.max(loc.targetStock[focusGood] ?? 0, 80 + i * 24);
      market.stock[focusGood] = i % 3 === 0 ? 20 + i * 7 : 180 + i * 32;
      market.prices[focusGood] = roundPrice(base * (i % 3 === 0 ? 1.72 : i % 3 === 1 ? 0.72 : 1.08));
      if (i % 3 === 1 && !loc.produces.some(p => p.good === focusGood)) {
        loc.produces.push({ good: focusGood, ratePerTick: 1.2 + i * 0.18 });
      }
      if (i % 3 === 0 && !loc.consumes.some(c => c.good === focusGood)) {
        loc.consumes.push({ good: focusGood, ratePerTick: 1.8 + i * 0.2 });
      }
    }

    world.commoditySpotHistory = world.commoditySpotHistory ?? {};
    for (const good of goods) {
      const drift = good.id === focusGood ? 1.36 : good.category === "luxury" ? 1.18 : good.category === "raw" ? 0.88 : 1.05;
      seedSpotHistory(good, drift);
    }

    useStore.setState({
      world,
      speed: 0,
      selectedTab: "markets",
      selectedGood: focusGood,
      commodityTab: "all",
      saveStatus: "saved",
      lastError: null,
      tickEpoch: state.tickEpoch + 1,
    });
    window.__LEDGWAY_CAPTURE_MARKET_GOOD__ = focusGood;
    return { ok: true, focusGood, history: world.commoditySpotHistory[focusGood]?.length ?? 0 };

    function seedSpotHistory(good, drift) {
      const points = [];
      const start = Math.max(0, world.tick - 149);
      const basePrice = Math.max(1, good.basePrice ?? 10);
      for (let i = 0; i < 150; i++) {
        const progress = i / 149;
        const wave = Math.sin(i * 0.23 + good.id.length) * 0.04 + Math.cos(i * 0.13) * 0.018;
        points.push({ tick: start + i, price: roundPrice(basePrice * (1 + (drift - 1) * progress) * (1 + wave)) });
      }
      world.commoditySpotHistory[good.id] = points;
    }

    function roundPrice(value) {
      return Math.max(0.01, Math.round(value * 100) / 100);
    }
  });
  if (!result?.ok) throw new Error(`Could not enrich markets developer state: ${result?.reason ?? "unknown"}`);
  console.log(`prepared markets state: ${result.focusGood} with ${result.history} spot samples`);
  await page.waitForSelector(".markets-view");
  await page.waitForSelector(".markets-selector-row");
  await page.wait(450);
}

async function enrichAtlasDeveloperState(page) {
  const result = await page.evaluate(() => {
    const useStore = window.__LEDGWAY_CAPTURE_STORE__;
    if (!useStore) return { ok: false, reason: "capture store hook unavailable" };
    const state = useStore.getState();
    const world = state.world;
    const player = world.player;
    const shipId = player?.shipIds?.[0];
    const ship = shipId ? world.traders[shipId] : null;
    if (!player || !ship) return { ok: false, reason: "missing player ship" };

    world.tick = Math.max(world.tick ?? 0, 520);
    const locations = Object.values(world.locations ?? {});
    if (locations.length < 2) return { ok: false, reason: "not enough locations" };
    const shipyard = locations.find(loc => loc.traits.tags.includes("shipyard")) ?? locations[0];
    if (!shipyard.traits.tags.includes("shipyard")) shipyard.traits.tags.push("shipyard");
    const neighborId = Object.keys(world.lanes[shipyard.id] ?? {})[0] ?? locations.find(loc => loc.id !== shipyard.id)?.id;
    const other = neighborId ? world.locations[neighborId] : locations.find(loc => loc.id !== shipyard.id);
    if (!other) return { ok: false, reason: "missing atlas route" };

    ship.state = "idle";
    ship.location = shipyard.id;
    ship.destination = null;
    ship.ticksRemaining = 0;
    ship.funds = Math.max(ship.funds ?? 0, 12_500_000);

    world.shipyardInventory = world.shipyardInventory ?? {};
    world.shipyardInventory[shipyard.id] = [
      {
        id: "wiki-cruiser-01",
        locationId: shipyard.id,
        name: "Cobalt Warden",
        class: "cruiser",
        classLabel: "Cruiser",
        flavor: "Heavy plate, extra mounts, and enough range to make dangerous lanes feel negotiable.",
        baseCapacity: 88,
        baseSpeed: 1.28,
        baseFuelCapacity: 76,
        baseHull: 9,
        baseWeaponPower: 5,
        fuelType: "antimatter",
        preInstalled: { hull: "upg_hull_2", weapon: "upg_weapon_2", systems: "upg_systems_nav_1" },
        traits: ["extra-slot"],
        price: 6_850_000,
        postedTick: world.tick - 12,
        expiresAtTick: world.tick + 520,
      },
      {
        id: "wiki-exotic-01",
        locationId: shipyard.id,
        name: "Oracle Needle",
        class: "exotic",
        classLabel: "Exotic",
        flavor: "Self-guided courier-brain wrapped around a high-risk, high-response frame.",
        baseCapacity: 64,
        baseSpeed: 1.82,
        baseFuelCapacity: 58,
        baseHull: 6,
        baseWeaponPower: 4,
        fuelType: "plasma",
        preInstalled: { engine: "upg_engine_3", systems: "upg_systems_oracle_3", weapon: "upg_weapon_emp_3" },
        traits: ["self-piloted", "ai-navigator", "fuel-efficient"],
        price: 11_900_000,
        postedTick: world.tick - 4,
        expiresAtTick: world.tick + 640,
      },
    ];

    const activeEvents = [
      {
        uid: "wiki-news-1",
        templateId: "wiki-border-raids",
        spawnedAt: world.tick - 18,
        expiresAt: world.tick + 94,
        category: "Security",
        tone: "warn",
        headline: `${other.name} corridor reports armed boardings`,
        body: "Convoys are rerouting around the lane until patrols regain control.",
        effects: [
          { scope: "encounter_chance", target: { kind: "location", id: other.id }, magnitude: 0.28, direction: 1 },
          { scope: "contract_reward", target: { kind: "location", id: other.id }, magnitude: 0.16, direction: 1 },
        ],
      },
      {
        uid: "wiki-news-2",
        templateId: "wiki-shipyard-surge",
        spawnedAt: world.tick - 9,
        expiresAt: world.tick + 170,
        category: "Industry",
        tone: "good",
        headline: `${shipyard.name} opens a refit allocation`,
        body: "Shipyard brokers are discounting hull inspections while inventory turns over.",
        effects: [
          { scope: "upgrade_cost", target: { kind: "location", id: shipyard.id }, magnitude: 0.12, direction: -1 },
          { scope: "maintenance", target: { kind: "location", id: shipyard.id }, magnitude: 0.10, direction: -1 },
        ],
      },
    ];
    world.newsEvents = {
      enabled: true,
      active: activeEvents,
      recent: activeEvents.map(ev => ({ uid: ev.uid, templateId: ev.templateId, tick: ev.spawnedAt, effects: ev.effects })),
      bias: {},
      nextEventId: 3,
    };

    world.encounterHistory = buildEncounterHistory(shipId, shipyard.id, other.id);
    world.pendingEncounter = undefined;
    window.__LEDGWAY_CAPTURE_SHIPYARD_ID__ = shipyard.id;

    useStore.setState({
      world,
      speed: 0,
      selectedTab: "locations",
      selectedTrader: shipId,
      selectedLocation: shipyard.id,
      atlasMapTab: "stations",
      atlasSheetTab: "systems",
      saveStatus: "saved",
      lastError: null,
      tickEpoch: state.tickEpoch + 1,
    });
    return { ok: true, shipyard: shipyard.name, encounters: world.encounterHistory.length, events: activeEvents.length };

    function buildEncounterHistory(activeShipId, from, to) {
      const rows = [];
      const names = ["Glass Hook", "Red Writ", "Null Choir", "Iron Tithe", "Vane Corsairs", "Blind Ledger", "Harbor Teeth", "Kite Patrol", "Cinder Wake", "Noon Knives", "Copper Host", "Quiet Claim"];
      const outcomes = ["won", "escaped", "fled_damaged", "negotiated_partial"];
      const choices = ["fight", "flee", "negotiate"];
      for (let i = 0; i < 12; i++) {
        rows.push({
          id: `wiki-enc-${i + 1}`,
          spawnedAt: world.tick - 14 - i * 13,
          shipId: activeShipId,
          fromLocation: i % 2 === 0 ? from : to,
          toLocation: i % 2 === 0 ? to : from,
          attacker: {
            name: names[i % names.length],
            kind: i % 3 === 0 ? "rival_syndicate" : "pirate",
            weaponPower: 2 + (i % 5),
            hull: 4 + (i % 4),
            speed: 1.05 + (i % 3) * 0.18,
            crewLevel: 0.35 + (i % 4) * 0.12,
          },
          pFight: 0.64,
          pFlee: 0.56,
          pNegotiate: 0.42,
          oddsFight: "likely",
          oddsFlee: "even",
          oddsNegotiate: "risky",
          fightLossOnFail: { credits: 1600 + i * 110, cargo: [], hull: 1 + (i % 2) },
          fleeLossOnFail: { credits: 0, cargo: [], hull: 1 + (i % 3) },
          negotiateBribe: 900 + i * 80,
          negotiatePartialCargo: [{ good: "parts", qty: 2 + (i % 3) }],
          resolution: {
            choice: choices[i % choices.length],
            outcome: outcomes[i % outcomes.length],
            tick: world.tick - 12 - i * 13,
            loss: i % 4 === 2 ? { credits: 0, cargo: [], hull: 2 } : undefined,
            autoResolved: i % 5 === 0,
          },
        });
      }
      return rows;
    }
  });
  if (!result?.ok) throw new Error(`Could not enrich atlas developer state: ${result?.reason ?? "unknown"}`);
  console.log(`prepared atlas state: ${result.shipyard}, ${result.encounters} encounters, ${result.events} events`);
  await page.waitForSelector(".atlas-view");
  await page.waitForSelector(".atlas-detail-panel");
  await page.wait(450);
}

async function enrichLedgerDeveloperState(page) {
  const result = await page.evaluate(() => {
    const useStore = window.__LEDGWAY_CAPTURE_STORE__;
    if (!useStore) return { ok: false, reason: "capture store hook unavailable" };
    const state = useStore.getState();
    const world = state.world;
    const player = world.player;
    const shipId = player?.shipIds?.[0];
    const ship = shipId ? world.traders[shipId] : null;
    if (!player || !ship) return { ok: false, reason: "missing player ship" };

    world.tick = Math.max(world.tick ?? 0, 560);
    player.manualActionCount = 420;
    const locIds = Object.keys(world.locations);
    const from = ship.location;
    const to = Object.keys(world.lanes[from] ?? {})[0] ?? locIds.find(id => id !== from) ?? from;
    if (!world.encounterHistory || world.encounterHistory.length < 6) {
      world.encounterHistory = buildEncounterHistory(shipId, from, to);
    }
    ship.log = [
      { tick: world.tick - 88, kind: "buy", message: "Loaded 32 Polymer at South Haven Hub.", tone: "info" },
      { tick: world.tick - 72, kind: "depart", message: "Departed toward Spring Bloom via safe lane.", tone: "info" },
      { tick: world.tick - 51, kind: "sell", message: "Sold 28 Polymer into a shortage market.", tone: "good" },
      { tick: world.tick - 33, kind: "contract", message: "Accepted Machine Parts shortage contract.", tone: "warn" },
      { tick: world.tick - 16, kind: "refuel", message: "Refueled antimatter reserves before a hostile corridor.", tone: "info" },
    ];
    ship.stockTrades = [
      { id: "wiki-ledger-tr-1", tick: world.tick - 64, equityId: "wiki", ticker: "PLS", action: "open_long", shares: 60, price: 42.4, fee: 25.44, cashFlow: -2569.44 },
      { id: "wiki-ledger-tr-2", tick: world.tick - 44, equityId: "wiki", ticker: "PLS", action: "close_long", shares: 18, price: 48.9, fee: 8.8, cashFlow: 871.4, realizedPnl: 117, trigger: "take_profit" },
      { id: "wiki-ledger-tr-3", tick: world.tick - 21, equityId: "wiki", ticker: "SYN", action: "open_short", shares: 24, price: 31.2, fee: 7.49, cashFlow: 741.31 },
    ];

    useStore.setState({
      world,
      speed: 0,
      selectedTab: "charters",
      selectedTrader: shipId,
      ledgerTab: "charters",
      saveStatus: "saved",
      lastError: null,
      tickEpoch: state.tickEpoch + 1,
    });
    return { ok: true, actions: player.manualActionCount, encounters: world.encounterHistory.length, logs: ship.log.length + ship.stockTrades.length };

    function buildEncounterHistory(activeShipId, fromLoc, toLoc) {
      const rows = [];
      const names = ["Glass Hook", "Red Writ", "Null Choir", "Iron Tithe", "Vane Corsairs", "Blind Ledger"];
      const outcomes = ["won", "escaped", "fled_damaged", "negotiated_partial"];
      const choices = ["fight", "flee", "negotiate"];
      for (let i = 0; i < 8; i++) {
        rows.push({
          id: `wiki-ledger-enc-${i + 1}`,
          spawnedAt: world.tick - 20 - i * 17,
          shipId: activeShipId,
          fromLocation: i % 2 === 0 ? fromLoc : toLoc,
          toLocation: i % 2 === 0 ? toLoc : fromLoc,
          attacker: { name: names[i % names.length], kind: "pirate", weaponPower: 2 + (i % 4), hull: 4 + (i % 3), speed: 1.1, crewLevel: 0.45 },
          pFight: 0.64,
          pFlee: 0.56,
          pNegotiate: 0.42,
          oddsFight: "likely",
          oddsFlee: "even",
          oddsNegotiate: "risky",
          fightLossOnFail: { credits: 1400 + i * 90, cargo: [], hull: 1 + (i % 2) },
          fleeLossOnFail: { credits: 0, cargo: [], hull: 1 + (i % 3) },
          negotiateBribe: 700 + i * 70,
          negotiatePartialCargo: [{ good: "parts", qty: 1 + (i % 3) }],
          resolution: {
            choice: choices[i % choices.length],
            outcome: outcomes[i % outcomes.length],
            tick: world.tick - 18 - i * 17,
            loss: i % 4 === 2 ? { credits: 0, cargo: [], hull: 2 } : undefined,
            autoResolved: i % 3 === 0,
          },
        });
      }
      return rows;
    }
  });
  if (!result?.ok) throw new Error(`Could not enrich ledger developer state: ${result?.reason ?? "unknown"}`);
  console.log(`prepared ledger state: ${result.actions} actions, ${result.encounters} encounters, ${result.logs} log entries`);
  await page.waitForSelector(".charters-view");
  await page.wait(350);
}

async function enrichCombatDeveloperState(page) {
  const result = await page.evaluate(() => {
    const useStore = window.__LEDGWAY_CAPTURE_STORE__;
    if (!useStore) return { ok: false, reason: "capture store hook unavailable" };
    const state = useStore.getState();
    const world = state.world;
    const player = world.player;
    const shipId = player?.shipIds?.[0];
    const ship = shipId ? world.traders[shipId] : null;
    if (!player || !ship) return { ok: false, reason: "missing player ship" };

    world.tick = Math.max(world.tick ?? 0, 680);
    player.manualActionCount = Math.max(player.manualActionCount ?? 0, 440);

    const locations = Object.values(world.locations ?? {});
    if (locations.length < 2) return { ok: false, reason: "not enough locations" };
    let from = ship.location && world.locations[ship.location] ? ship.location : locations[0].id;
    let to = Object.keys(world.lanes[from] ?? {})[0];
    if (!to) {
      from = locations[0].id;
      to = Object.keys(world.lanes[from] ?? {})[0] ?? locations.find(loc => loc.id !== from)?.id;
    }
    if (!to) return { ok: false, reason: "missing route for combat capture" };

    const goods = Object.values(world.goods ?? {}).filter(good => good.category !== "upgrade");
    const cargoGoodA = world.goods.polymer?.id ?? goods.find(good => good.category === "intermediate")?.id ?? goods[0]?.id;
    const cargoGoodB = world.goods.parts?.id ?? goods.find(good => good.category === "advanced")?.id ?? cargoGoodA;
    if (!cargoGoodA || !cargoGoodB) return { ok: false, reason: "missing cargo goods" };

    ship.name = "Voyager";
    ship.location = from;
    ship.destination = to;
    ship.state = "transit";
    ship.ticksRemaining = 3;
    ship.pilot = "manual";
    ship.funds = 214_800;
    ship.baseHull = Math.max(ship.baseHull ?? 0, 8);
    ship.hull = Math.max(ship.hull ?? 0, 8);
    ship.baseWeaponPower = Math.max(ship.baseWeaponPower ?? 0, 3);
    ship.weaponPower = Math.max(ship.weaponPower ?? 0, 5);
    ship.baseSpeed = Math.max(ship.baseSpeed ?? 0, 4);
    ship.speed = Math.max(ship.speed ?? 0, 4);
    ship.currentFuel = ship.currentFuel ?? { good: "plasma", qty: Math.max(12, Math.floor((ship.fuelCapacity ?? 48) * 0.4)) };
    ship.cargo = [
      { good: cargoGoodA, qty: 34, source: from, unitPrice: world.goods[cargoGoodA]?.basePrice ?? 10, purchasedAt: world.tick - 24 },
      { good: cargoGoodB, qty: 12, source: from, unitPrice: world.goods[cargoGoodB]?.basePrice ?? 60, purchasedAt: world.tick - 19 },
    ];
    ship.crew = {
      ...(ship.crew ?? {}),
      mercenary: {
        id: "wiki-combat-merc",
        role: "mercenary",
        name: "Ilya Knox",
        tier: 2,
        hireCost: 0,
        wagePerTick: 180,
        modifiers: { weaponPowerBonus: 3, hullBonus: 2 },
        sex: "nonbinary",
        age: "adult",
        race: "human",
      },
    };

    const pending = buildPendingEncounter(shipId, from, to, cargoGoodA, cargoGoodB);
    world.pendingEncounter = pending;
    world.encounterHistory = buildEncounterHistory(shipId, from, to, cargoGoodA, cargoGoodB);
    world.nextEncounterId = Math.max(world.nextEncounterId ?? 1, 200);
    window.__LEDGWAY_CAPTURE_COMBAT_PENDING__ = JSON.parse(JSON.stringify(pending));

    const fromName = world.locations[from]?.name ?? from;
    const toName = world.locations[to]?.name ?? to;
    world.newsEvents = {
      enabled: true,
      active: [
        {
          uid: "wiki-combat-news-1",
          templateId: "wiki-combat-lane-raids",
          spawnedAt: world.tick - 16,
          expiresAt: world.tick + 120,
          category: "Security",
          tone: "warn",
          headline: `${fromName} to ${toName} corridor reports armed boardings`,
          body: "Convoys are slowing departures until patrols push the raiders off the lane.",
          effects: [
            { scope: "encounter_chance", target: { kind: "location", id: to }, magnitude: 0.34, direction: 1 },
            { scope: "contract_reward", target: { kind: "location", id: to }, magnitude: 0.12, direction: 1 },
          ],
        },
      ],
      recent: [],
      bias: {},
      nextEventId: 2,
    };
    world.newsEvents.recent = world.newsEvents.active.map(ev => ({
      uid: ev.uid,
      templateId: ev.templateId,
      tick: ev.spawnedAt,
      effects: ev.effects,
    }));

    ship.log = [
      { tick: world.tick - 40, kind: "depart", message: `Departed ${fromName} for ${toName}.`, tone: "info" },
      { tick: world.tick - 18, kind: "encounter", message: "Outran Red Writ near the border lane.", tone: "good" },
      { tick: world.tick - 9, kind: "encounter", message: "Paid off Glass Hook with cargo concession.", tone: "warn" },
    ];

    useStore.setState({
      world,
      speed: 0,
      selectedTab: "player",
      selectedTrader: shipId,
      selectedLocation: from,
      saveStatus: "saved",
      lastError: null,
      tickEpoch: state.tickEpoch + 1,
    });

    return { ok: true, route: `${fromName} -> ${toName}`, encounters: world.encounterHistory.length };

    function buildPendingEncounter(activeShipId, fromLoc, toLoc, goodA, goodB) {
      return {
        id: "wiki-combat-pending",
        spawnedAt: world.tick,
        shipId: activeShipId,
        fromLocation: fromLoc,
        toLocation: toLoc,
        attacker: {
          name: "Black Aubade",
          kind: "pirate",
          weaponPower: 4,
          hull: 6,
          speed: 3,
          crewLevel: 0.54,
        },
        pFight: 0.68,
        pFlee: 0.46,
        pNegotiate: 0.45,
        oddsFight: "likely",
        oddsFlee: "risky",
        oddsNegotiate: "even",
        fightLossOnFail: {
          credits: 6500,
          cargo: [
            { good: goodA, qty: 8 },
            { good: goodB, qty: 3 },
          ],
          hull: 2,
        },
        fleeLossOnFail: { credits: 0, cargo: [], hull: 1 },
        negotiateBribe: 4200,
        negotiatePartialCargo: [{ good: goodA, qty: 4 }],
      };
    }

    function buildEncounterHistory(activeShipId, fromLoc, toLoc, goodA, goodB) {
      const rows = [];
      const names = ["Red Writ", "Glass Hook", "Null Choir", "Iron Tithe", "Vane Corsairs", "Blind Ledger", "Harbor Teeth", "Cinder Wake", "Noon Knives", "Copper Host", "Quiet Claim", "Saltbreaker"];
      const outcomes = ["won", "escaped", "fled_damaged", "negotiated_partial", "negotiated_fail"];
      const choices = ["fight", "flee", "negotiate"];
      for (let i = 0; i < 16; i++) {
        const choice = choices[i % choices.length];
        const outcome = outcomes[i % outcomes.length];
        const loss =
          outcome === "fled_damaged" ? { credits: 0, cargo: [], hull: 2 } :
          outcome === "negotiated_partial" ? { credits: 1300 + i * 80, cargo: [{ good: goodA, qty: 1 + (i % 3) }], hull: 0 } :
          outcome === "negotiated_fail" ? { credits: 2600 + i * 120, cargo: [{ good: goodB, qty: 1 + (i % 2) }], hull: 2 } :
          undefined;
        rows.push({
          id: `wiki-combat-enc-${i + 1}`,
          spawnedAt: world.tick - 4 - i * 12,
          shipId: activeShipId,
          fromLocation: i % 2 === 0 ? fromLoc : toLoc,
          toLocation: i % 2 === 0 ? toLoc : fromLoc,
          attacker: {
            name: names[i % names.length],
            kind: i % 4 === 0 ? "rival_syndicate" : "pirate",
            syndicateId: i % 4 === 0 ? world.locations[toLoc]?.traits.faction : undefined,
            weaponPower: 2 + (i % 5),
            hull: 4 + (i % 4),
            speed: 2 + (i % 3),
            crewLevel: 0.28 + (i % 5) * 0.12,
          },
          pFight: 0.58,
          pFlee: 0.52,
          pNegotiate: 0.44,
          oddsFight: i % 3 === 0 ? "likely" : "even",
          oddsFlee: i % 3 === 1 ? "likely" : "even",
          oddsNegotiate: i % 4 === 0 ? "likely" : "risky",
          fightLossOnFail: { credits: 1800 + i * 130, cargo: [{ good: goodA, qty: 2 + (i % 3) }], hull: 1 + (i % 2) },
          fleeLossOnFail: { credits: 0, cargo: [], hull: 1 + (i % 2) },
          negotiateBribe: 1200 + i * 90,
          negotiatePartialCargo: [{ good: goodA, qty: 1 + (i % 3) }],
          resolution: {
            choice,
            outcome,
            tick: world.tick - 2 - i * 12,
            loss,
            autoResolved: i % 4 === 1,
          },
        });
      }
      return rows;
    }
  });
  if (!result?.ok) throw new Error(`Could not enrich combat developer state: ${result?.reason ?? "unknown"}`);
  console.log(`prepared combat state: ${result.route}, ${result.encounters} encounters`);
  await page.waitForSelector(".ui-modal-dialog.encounter-dialog");
  await page.wait(350);
}

async function enrichSiteDeveloperState(page) {
  await enrichExchangeDeveloperState(page);
  await enrichMarketsDeveloperState(page);
  await enrichAtlasDeveloperState(page);
  await enrichMyFleetDeveloperState(page);
  await enrichLedgerDeveloperState(page);
  await selectMainTab(page, "Cargo");
}

async function showCombatEncounterModal(page) {
  const ok = await page.evaluate(() => {
    const useStore = window.__LEDGWAY_CAPTURE_STORE__;
    if (!useStore) return false;
    const pending = window.__LEDGWAY_CAPTURE_COMBAT_PENDING__;
    if (!pending) return false;
    const state = useStore.getState();
    const world = state.world;
    world.pendingEncounter = JSON.parse(JSON.stringify(pending));
    useStore.setState({
      world,
      speed: 0,
      selectedTab: "player",
      saveStatus: "saved",
      lastError: null,
      tickEpoch: state.tickEpoch + 1,
    });
    return true;
  });
  if (!ok) throw new Error("Could not show combat encounter modal");
  await page.waitForSelector(".ui-modal-dialog.encounter-dialog");
  await page.wait(180);
}

async function clearCombatEncounterModal(page) {
  await page.evaluate(() => {
    const useStore = window.__LEDGWAY_CAPTURE_STORE__;
    if (!useStore) return;
    const state = useStore.getState();
    const world = state.world;
    world.pendingEncounter = undefined;
    useStore.setState({
      world,
      speed: 0,
      saveStatus: "saved",
      lastError: null,
      tickEpoch: state.tickEpoch + 1,
    });
  });
  await page.wait(180);
}

async function openGameMenu(page) {
  await page.evaluate(() => {
    const button = document.querySelector('button[aria-label="Open save menu"]');
    if (button instanceof HTMLButtonElement) button.click();
  });
  await page.waitForSelector(".topbar-save-modal");
}

async function closeGameMenu(page) {
  await page.evaluate(() => {
    const closeButton = document.querySelector(".ui-modal-close, .topbar-save-modal button[aria-label='Close']");
    if (closeButton instanceof HTMLButtonElement) {
      closeButton.click();
      return;
    }
    const backdrop = document.querySelector(".ui-modal-backdrop");
    if (backdrop instanceof HTMLElement) backdrop.click();
  });
  await page.wait(80);
}

async function selectMainTab(page, label) {
  await clickText(page, ".topbar-view-tabs", label);
  await page.wait(220);
}

async function selectShipTab(page, label) {
  await clickText(page, ".ship-cargo-tabs", label);
  await page.wait(140);
}

async function selectExchangeTab(page, label) {
  await clickText(page, ".exchange-card > .bridge-card-tabs", label);
  await page.wait(160);
}

async function selectExchangeListing(page, kind) {
  await page.evaluate((requestedKind) => {
    const labels = {
      all: "All",
      station: "Stations",
      syndicate: "Syndicates",
      commodity: "Commodities",
      basis: "Basis",
      futures: "Futures",
      index: "Indices",
    };
    const ids = window.__LEDGWAY_CAPTURE_EXCHANGE_IDS__ ?? {};
    const useStore = window.__LEDGWAY_CAPTURE_STORE__;
    if (useStore && requestedKind !== "all" && ids[requestedKind]) {
      useStore.getState().selectEquity(ids[requestedKind]);
    }
    const root = document.querySelector(".stocks-selector .bridge-card-tabs");
    const label = labels[requestedKind] ?? "All";
    const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
    const target = Array.from(root?.querySelectorAll("button") ?? [])
      .find((button) => normalize(button.textContent ?? "").includes(normalize(label)));
    if (target instanceof HTMLButtonElement) target.click();
  }, kind);
  await page.wait(260);
}

async function selectPnoTab(page, label) {
  await clickText(page, ".stocks-pno > .bridge-card-tabs", label);
  await page.wait(180);
}

async function selectMarketsCategory(page, label) {
  await clickText(page, ".markets-tabs", label);
  await page.wait(220);
}

async function selectAtlasMapTab(page, label) {
  await clickText(page, ".atlas-map-tabs", label);
  await page.wait(220);
}

async function selectAtlasSheetTab(page, label) {
  await clickText(page, ".atlas-sheet-tabs", label);
  await page.wait(220);
}

async function selectLedgerTab(page, label) {
  await clickText(page, ".charters-badges-tabs", label);
  await page.wait(220);
}

async function focusShipyard(page) {
  const ok = await page.evaluate(() => {
    const useStore = window.__LEDGWAY_CAPTURE_STORE__;
    if (!useStore) return false;
    const shipyardId = window.__LEDGWAY_CAPTURE_SHIPYARD_ID__
      ?? Object.values(useStore.getState().world.locations).find(loc => loc.traits.tags.includes("shipyard"))?.id;
    if (!shipyardId) return false;
    const state = useStore.getState();
    useStore.setState({
      selectedTab: "locations",
      selectedLocation: shipyardId,
      atlasMapTab: "stations",
      atlasSheetTab: "systems",
      tickEpoch: state.tickEpoch + 1,
    });
    return true;
  });
  if (!ok) throw new Error("Could not focus a shipyard in Atlas");
  await page.waitForSelector(".atlas-view");
  await page.wait(260);
}

async function openFirstShipyardBlueprint(page) {
  await page.evaluate(() => {
    const button = document.querySelector(".atlas-shipyard-summary");
    if (button instanceof HTMLButtonElement) {
      button.scrollIntoView({ block: "center", inline: "center" });
      button.click();
    }
  });
  await page.wait(180);
}

async function openFirstAccordion(page) {
  await page.evaluate(() => {
    const item = document.querySelector(".stocks-pno .stocks-accordion-item");
    if (!(item instanceof HTMLElement)) return false;
    if (item.classList.contains("open")) return true;
    const button = item.querySelector(".stocks-accordion-summary");
    if (button instanceof HTMLButtonElement) {
      button.scrollIntoView({ block: "center", inline: "center" });
      button.click();
      return true;
    }
    return false;
  });
  await page.wait(200);
}

async function clearInfoFocus(page) {
  await page.evaluate(() => {
    document.querySelectorAll(".info-area-tab-close").forEach((button) => {
      if (button instanceof HTMLButtonElement) button.click();
    });
    const emptyTabs = document.querySelector(".info-area-tabs");
    if (emptyTabs instanceof HTMLElement) emptyTabs.click();
  });
  await page.wait(100);
}

async function clickSelector(page, selector) {
  const ok = await page.evaluate((selectorArg) => {
    const element = document.querySelector(selectorArg);
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return true;
  }, selector);
  if (!ok) throw new Error(`No clickable element for selector: ${selector}`);
}

async function clickText(page, rootSelector, text) {
  const ok = await page.evaluate((root, expectedText) => {
    const rootElement = document.querySelector(root);
    if (!rootElement) return false;
    const normalize = (value) => value.replace(/\s+/g, " ").trim().toLowerCase();
    const needle = normalize(expectedText);
    const candidates = Array.from(rootElement.querySelectorAll("button, summary, a"));
    const element = candidates.find((candidate) => normalize(candidate.textContent ?? "").includes(needle));
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: "center", inline: "center" });
    element.click();
    return true;
  }, rootSelector, text);
  if (!ok) throw new Error(`No text click target "${text}" in ${rootSelector}`);
}

async function installCaptureStyle(page) {
  await page.evaluate(() => {
    if (document.getElementById("codex-capture-style")) return;
    const style = document.createElement("style");
    style.id = "codex-capture-style";
    style.textContent = `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        scroll-behavior: auto !important;
        caret-color: transparent !important;
      }

      body:not(.capture-show-suggestions) .suggested-marker {
        display: none !important;
      }
    `;
    document.head.append(style);
  });
}

async function setSuggestionOverlays(page, show) {
  await page.evaluate((showSuggestions) => {
    document.body.classList.toggle("capture-show-suggestions", showSuggestions);
  }, show);
}

async function scrollIntoView(page, selector) {
  await page.evaluate((selectorArg) => {
    const element = document.querySelector(selectorArg);
    if (element instanceof HTMLElement) {
      element.scrollIntoView({ block: "center", inline: "center" });
    }
  }, selector);
}

async function clipForSelector(page, selector, pad, maxHeight) {
  const data = await page.evaluate((selectorArg, padArg, maxHeightArg) => {
    const element = document.querySelector(selectorArg);
    if (!(element instanceof HTMLElement)) return null;
    const rect = element.getBoundingClientRect();
    const width = Math.ceil(rect.width + padArg * 2);
    const height = Math.ceil(Math.min(rect.height + padArg * 2, maxHeightArg ?? rect.height + padArg * 2));
    return {
      x: Math.max(0, Math.floor(rect.left + window.scrollX - padArg)),
      y: Math.max(0, Math.floor(rect.top + window.scrollY - padArg)),
      width: Math.min(width, document.documentElement.scrollWidth),
      height: Math.min(height, document.documentElement.scrollHeight),
    };
  }, selector, pad, maxHeight);
  if (!data) throw new Error(`Cannot compute clip for selector: ${selector}`);
  return { ...data, scale: 1 };
}

async function focusForSelector(page, selector, clip) {
  const rect = await page.evaluate((selectorArg) => {
    const element = document.querySelector(selectorArg);
    if (!(element instanceof HTMLElement)) return null;
    const bounds = element.getBoundingClientRect();
    return {
      x: bounds.left + window.scrollX,
      y: bounds.top + window.scrollY,
      width: bounds.width,
      height: bounds.height,
    };
  }, selector);
  if (!rect) return undefined;

  const x = clamp(((rect.x - clip.x) / clip.width) * 100, 0, 100);
  const y = clamp(((rect.y - clip.y) / clip.height) * 100, 0, 100);
  const right = clamp(((rect.x + rect.width - clip.x) / clip.width) * 100, 0, 100);
  const bottom = clamp(((rect.y + rect.height - clip.y) / clip.height) * 100, 0, 100);
  return {
    x: round(x),
    y: round(y),
    width: round(Math.max(0, right - x)),
    height: round(Math.max(0, bottom - y)),
  };
}

function publicPath(absolutePath) {
  const relative = path.relative(PUBLIC_ROOT, absolutePath).split(path.sep).join("/");
  return `/${relative}`;
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function parseArgs(argv) {
  const parsed = {};
  for (const arg of argv) {
    if (!arg.startsWith("--")) continue;
    const [key, value = "true"] = arg.slice(2).split("=");
    parsed[key] = value;
  }
  return parsed;
}

async function resolveTargetUrl(explicitUrl) {
  if (explicitUrl) return explicitUrl;
  const candidates = [
    DEFAULT_URL,
    "http://127.0.0.1:5174/",
    "http://127.0.0.1:5175/",
    "http://127.0.0.1:5176/",
    "http://127.0.0.1:5177/",
    "http://127.0.0.1:5178/",
    "http://127.0.0.1:5179/",
  ];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { method: "HEAD" });
      if (response.ok) return candidate;
    } catch {
      // Try the next common Vite port.
    }
  }
  return DEFAULT_URL;
}

function findChromePath() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
  ].filter(Boolean);

  const chromePath = candidates.find((candidate) => candidate.includes(path.sep) ? existsSync(candidate) : true);
  if (!chromePath) {
    throw new Error("Could not find Chrome. Set CHROME_PATH=/path/to/chrome and retry.");
  }
  return chromePath;
}

async function findFreePort() {
  return new Promise((resolvePort, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address !== "object" || address == null) {
        server.close(() => reject(new Error("Could not allocate a port")));
        return;
      }
      const port = address.port;
      server.close(() => resolvePort(port));
    });
  });
}

async function waitForBrowser(port) {
  const deadline = Date.now() + 10_000;
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) return response.json();
    } catch {
      // Chrome is still starting.
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for Chrome DevTools endpoint.");
}

async function openPageTarget(port) {
  const endpoint = `http://127.0.0.1:${port}/json/new?about:blank`;
  const response = await fetch(endpoint, { method: "PUT" });
  if (!response.ok) {
    throw new Error(`Could not create Chrome page target: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function stopChrome(chrome) {
  if (chrome.exitCode != null || chrome.signalCode != null) return;
  const exited = new Promise((resolveExit) => chrome.once("exit", resolveExit));
  chrome.kill("SIGTERM");
  await Promise.race([exited, sleep(1_000)]);
  if (chrome.exitCode == null && chrome.signalCode == null) chrome.kill("SIGKILL");
}

class CdpPage {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.eventWaiters = new Map();
    this.ws.addEventListener("message", (event) => this.handleMessage(event));
    this.ws.addEventListener("error", (event) => {
      for (const { reject } of this.pending.values()) reject(event);
      this.pending.clear();
    });
  }

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((resolveOpen, reject) => {
      ws.addEventListener("open", resolveOpen, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    return new CdpPage(ws);
  }

  async enable() {
    await this.send("Page.enable");
    await this.send("Runtime.enable");
  }

  async setViewport({ width, height }) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }

  async navigate(url) {
    const loaded = this.once("Page.loadEventFired");
    await this.send("Page.navigate", { url });
    await loaded;
  }

  async waitForSelector(selector, timeoutMs = 7_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.evaluate((selectorArg) => Boolean(document.querySelector(selectorArg)), selector);
      if (found) return;
      await this.wait(80);
    }
    throw new Error(`Timed out waiting for selector: ${selector}`);
  }

  async capturePng(filePath, clip) {
    const result = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      fromSurface: true,
      clip,
    });
    await writeFile(filePath, Buffer.from(result.data, "base64"));
  }

  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(...${JSON.stringify(args)})`;
    const result = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text ?? "Runtime.evaluate failed");
    }
    return result.result.value;
  }

  async wait(ms) {
    await sleep(ms);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    const message = JSON.stringify({ id, method, params });
    const promise = new Promise((resolveSend, reject) => {
      this.pending.set(id, { resolve: resolveSend, reject });
    });
    this.ws.send(message);
    return promise;
  }

  once(method) {
    return new Promise((resolveOnce) => {
      const waiters = this.eventWaiters.get(method) ?? [];
      waiters.push(resolveOnce);
      this.eventWaiters.set(method, waiters);
    });
  }

  handleMessage(event) {
    const payload = JSON.parse(event.data);
    if (payload.id) {
      const pending = this.pending.get(payload.id);
      if (!pending) return;
      this.pending.delete(payload.id);
      if (payload.error) pending.reject(new Error(payload.error.message));
      else pending.resolve(payload.result);
      return;
    }

    if (payload.method) {
      const waiters = this.eventWaiters.get(payload.method);
      if (!waiters || waiters.length === 0) return;
      this.eventWaiters.delete(payload.method);
      for (const waiter of waiters) waiter(payload.params);
    }
  }

  close() {
    this.ws.close();
  }
}
