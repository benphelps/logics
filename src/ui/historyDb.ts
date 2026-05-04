import type { BookTrade, Equity, EquityId, GoodId, ShipLogEntry, TradeRecord, TraderId, World } from "../sim/types";
import type { RecentNewsEvent } from "../sim/news/types";

// Preserve the pre-rename IndexedDB name so existing local history streams
// stay attached to migrated Ledgway saves.
const DB_NAME = "logics-history";
const DB_VERSION = 5;
const STORE_HISTORY = "equityHistory";
const STORE_TRADES = "equityTrades";
const STORE_LOG = "traderLog";
const STORE_LEDGER = "tradeLedger";
const STORE_NEWS = "newsEvents";
const STORE_SPOT_HISTORY = "commoditySpotHistory";
// Save world payloads. Keyed on the save slot id (string). Worlds got too
// big for localStorage's ~5 MB per-origin quota once cargo lots, positions,
// and contracts accumulated; IDB has no such practical cap. localStorage
// keeps only the small slot-summary registry now.
const STORE_SAVE_WORLDS = "saveWorlds";
const IDX_TRADES = "byEquityTick";
const IDX_LOG = "byTraderTick";
const IDX_LEDGER_SHIP = "byShipTick";
const IDX_LEDGER_GAME = "byGameTick";
const IDX_NEWS_GAME = "byGameTick";

export interface HistorySample {
  gameId: string;
  equityId: EquityId;
  tick: number;
  price: number;
}

// Per-good universe-wide volume-weighted spot price samples — physical
// commodity pricing, separate from the Exchange's commodity equity series.
// Markets view chart reads from this store.
export interface SpotHistorySample {
  gameId: string;
  goodId: GoodId;
  tick: number;
  price: number;
}

export interface PersistedTrade extends BookTrade {
  gameId: string;
}

export interface PersistedLogEntry extends ShipLogEntry {
  gameId: string;
  traderId: TraderId;
}

// The player trade ledger — buys/sells/settlements with realized P&L.
// Persisted per (gameId, shipId) so the History tab can lazy-load older
// entries past whatever's currently in memory.
export interface PersistedTradeRecord extends TradeRecord {
  gameId: string;
  shipId: TraderId;
}

// Expired news events. The in-memory `state.recent` is a small ring; the
// IDB store retains them forever so a future "news archive" UI can paginate
// arbitrarily far back. uid is unique per event, so it's the natural pk.
export interface PersistedNewsEvent extends RecentNewsEvent {
  gameId: string;
}

// Per-(gameId) high-water marks. We only flush samples with tick > the mark
// to avoid re-writing on every save. Reset implicitly on page reload — load
// re-seeds these to world.tick before any new samples can be appended.
const historyHighWater = new Map<string, number>();
const tradesHighWater = new Map<string, number>();
const logHighWater = new Map<string, number>();
const ledgerHighWater = new Map<string, number>();
const newsHighWater = new Map<string, number>();
const spotHighWater = new Map<string, number>();

// Per-gameId chain of pending flushes. Two saves in quick succession serialize
// rather than racing the same high-water mark. hydrateHistoryRings awaits the
// chain so we never read IDB while a flush of fresh-world rings is still in
// flight (otherwise an immediately-following hydrate would clobber the rings
// with empty data).
const pendingFlushes = new Map<string, Promise<void>>();

let dbPromise: Promise<IDBDatabase | null> | null = null;

function indexedDbApi(): IDBFactory | null {
  if (typeof indexedDB !== "undefined") return indexedDB;
  if (typeof globalThis !== "undefined" && (globalThis as { indexedDB?: IDBFactory }).indexedDB) {
    return (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null;
  }
  return null;
}

export function openHistoryDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const api = indexedDbApi();
  if (!api) return Promise.resolve(null);
  dbPromise = new Promise<IDBDatabase | null>((resolve) => {
    const req = api.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        db.createObjectStore(STORE_HISTORY, { keyPath: ["gameId", "equityId", "tick"] });
      }
      if (!db.objectStoreNames.contains(STORE_TRADES)) {
        const trades = db.createObjectStore(STORE_TRADES, { autoIncrement: true });
        trades.createIndex(IDX_TRADES, ["gameId", "equityId", "tick"], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_LOG)) {
        const log = db.createObjectStore(STORE_LOG, { autoIncrement: true });
        log.createIndex(IDX_LOG, ["gameId", "traderId", "tick"], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_LEDGER)) {
        // Player trade ledger. TradeRecord.id is a unique string from the
        // sim — use it as the primary key so re-flushing is idempotent.
        // Two indexes: per-ship-then-tick for hydrate, per-game-then-tick
        // for the "all my trades, newest first" UI query.
        const ledger = db.createObjectStore(STORE_LEDGER, { keyPath: "id" });
        ledger.createIndex(IDX_LEDGER_SHIP, ["gameId", "shipId", "tick"], { unique: false });
        ledger.createIndex(IDX_LEDGER_GAME, ["gameId", "tick"], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_NEWS)) {
        // Expired news events. The sim assigns a stable uid per event;
        // pair it with gameId for the compound primary key. Range queries
        // by tick happen via the byGameTick index.
        const news = db.createObjectStore(STORE_NEWS, { keyPath: ["gameId", "uid"] });
        news.createIndex(IDX_NEWS_GAME, ["gameId", "tick"], { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SPOT_HISTORY)) {
        db.createObjectStore(STORE_SPOT_HISTORY, { keyPath: ["gameId", "goodId", "tick"] });
      }
      if (!db.objectStoreNames.contains(STORE_SAVE_WORLDS)) {
        // World payload per save slot. Key is the slot id (string). Value
        // is the compacted World JSON; the slot summary stays in
        // localStorage so cold-start can render the save list synchronously.
        db.createObjectStore(STORE_SAVE_WORLDS);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn("[ledgway] historyDb open failed", req.error);
      resolve(null);
    };
  });
  return dbPromise;
}

// Reset cached open Promise. Used by tests to swap fake-indexeddb instances.
// Closes any open connection so a subsequent indexedDB.deleteDatabase call
// isn't blocked by the cached handle.
export async function __resetHistoryDbForTests(): Promise<void> {
  const existing = dbPromise;
  dbPromise = null;
  historyHighWater.clear();
  tradesHighWater.clear();
  logHighWater.clear();
  ledgerHighWater.clear();
  newsHighWater.clear();
  spotHighWater.clear();
  pendingFlushes.clear();
  if (existing) {
    try {
      const db = await existing;
      if (db) db.close();
    } catch {
      // open failed earlier — nothing to close
    }
  }
}

function reqAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

// --- writes -----------------------------------------------------------------

export async function putHistory(samples: HistorySample[]): Promise<void> {
  if (samples.length === 0) return;
  const db = await openHistoryDb();
  if (!db) return;
  const tx = db.transaction(STORE_HISTORY, "readwrite");
  const store = tx.objectStore(STORE_HISTORY);
  for (const s of samples) store.put(s);
  await txDone(tx);
}

export async function putTrades(trades: PersistedTrade[]): Promise<void> {
  if (trades.length === 0) return;
  const db = await openHistoryDb();
  if (!db) return;
  const tx = db.transaction(STORE_TRADES, "readwrite");
  const store = tx.objectStore(STORE_TRADES);
  for (const t of trades) store.add(t);
  await txDone(tx);
}

export async function putLog(entries: PersistedLogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const db = await openHistoryDb();
  if (!db) return;
  const tx = db.transaction(STORE_LOG, "readwrite");
  const store = tx.objectStore(STORE_LOG);
  for (const e of entries) store.add(e);
  await txDone(tx);
}

export async function putTradeRecords(records: PersistedTradeRecord[]): Promise<void> {
  if (records.length === 0) return;
  const db = await openHistoryDb();
  if (!db) return;
  const tx = db.transaction(STORE_LEDGER, "readwrite");
  const store = tx.objectStore(STORE_LEDGER);
  // Primary key is TradeRecord.id (a unique sim-side id); put is idempotent.
  for (const r of records) store.put(r);
  await txDone(tx);
}

export async function putSpotHistory(samples: SpotHistorySample[]): Promise<void> {
  if (samples.length === 0) return;
  const db = await openHistoryDb();
  if (!db) return;
  const tx = db.transaction(STORE_SPOT_HISTORY, "readwrite");
  const store = tx.objectStore(STORE_SPOT_HISTORY);
  for (const s of samples) store.put(s);
  await txDone(tx);
}

export async function putNewsEvents(events: PersistedNewsEvent[]): Promise<void> {
  if (events.length === 0) return;
  const db = await openHistoryDb();
  if (!db) return;
  const tx = db.transaction(STORE_NEWS, "readwrite");
  const store = tx.objectStore(STORE_NEWS);
  // Primary key is [gameId, uid]; put is idempotent.
  for (const e of events) store.put(e);
  await txDone(tx);
}

// --- world flush ------------------------------------------------------------

// Extract anything in the world's in-memory rings that hasn't been written
// to IDB yet, and persist it. Fire-and-forget from saveGameSlot — we don't
// block the localStorage write on this. Returns a Promise so tests can await.
export function flushHistoryFromWorld(world: World): Promise<void> {
  const gameId = world.gameId;
  if (!gameId) return Promise.resolve();
  const previous = pendingFlushes.get(gameId) ?? Promise.resolve();
  const chained = previous.then(() => doFlush(world));
  pendingFlushes.set(gameId, chained);
  return chained;
}

async function doFlush(world: World): Promise<void> {
  const gameId = world.gameId;
  if (!gameId) return;

  const lastH = historyHighWater.get(gameId) ?? -1;
  const lastT = tradesHighWater.get(gameId) ?? -1;
  const lastL = logHighWater.get(gameId) ?? -1;
  const lastLedger = ledgerHighWater.get(gameId) ?? -1;
  const lastNews = newsHighWater.get(gameId) ?? -1;
  const lastSpot = spotHighWater.get(gameId) ?? -1;

  const history: HistorySample[] = [];
  const trades: PersistedTrade[] = [];
  const log: PersistedLogEntry[] = [];
  const ledger: PersistedTradeRecord[] = [];
  const news: PersistedNewsEvent[] = [];
  const spot: SpotHistorySample[] = [];

  let maxH = lastH, maxT = lastT, maxL = lastL, maxLedger = lastLedger, maxNews = lastNews, maxSpot = lastSpot;

  for (const eq of Object.values(world.equities ?? {})) {
    if (eq.history) {
      for (const point of eq.history) {
        if (point.tick > lastH) {
          history.push({ gameId, equityId: eq.id, tick: point.tick, price: point.price });
          if (point.tick > maxH) maxH = point.tick;
        }
      }
    }
    if (eq.recentTrades) {
      for (const trade of eq.recentTrades) {
        if (trade.tick > lastT) {
          trades.push({ ...trade, gameId });
          if (trade.tick > maxT) maxT = trade.tick;
        }
      }
    }
  }

  for (const trader of Object.values(world.traders ?? {})) {
    if (trader.log) {
      for (const entry of trader.log) {
        if (entry.tick > lastL) {
          log.push({ ...entry, gameId, traderId: trader.id });
          if (entry.tick > maxL) maxL = entry.tick;
        }
      }
    }
    if (trader.stockTrades) {
      for (const record of trader.stockTrades) {
        if (record.tick > lastLedger) {
          ledger.push({ ...record, gameId, shipId: trader.id });
          if (record.tick > maxLedger) maxLedger = record.tick;
        }
      }
    }
  }

  // Expired news events live in world.newsEvents.recent (a small ring); we
  // also persist them so a future news-archive UI can paginate forever.
  if (world.newsEvents?.recent) {
    for (const ev of world.newsEvents.recent) {
      if (ev.tick > lastNews) {
        news.push({ ...ev, gameId });
        if (ev.tick > maxNews) maxNews = ev.tick;
      }
    }
  }

  // Universe spot-price samples per good. Same high-water pattern as the
  // equity history ring above — only flush ticks past the last write.
  if (world.commoditySpotHistory) {
    for (const [goodId, ring] of Object.entries(world.commoditySpotHistory)) {
      for (const point of ring) {
        if (point.tick > lastSpot) {
          spot.push({ gameId, goodId, tick: point.tick, price: point.price });
          if (point.tick > maxSpot) maxSpot = point.tick;
        }
      }
    }
  }

  // Update high-water only after a successful write — failures keep the
  // previous mark so the next save retries the same range.
  // After a successful write the entries up to the new high-water are
  // safely persisted, so we trim the in-memory rings to bounded sizes —
  // the rings are also chart/T&S/log buffers but unbounded growth was
  // pinning hundreds of MB in heap and triggering major GC pauses on
  // every click. Older bars are still available via lazy IDB backfill
  // when the user scrolls past the kept window.
  // First-render windows. UI components show ~100 entries by default
  // (chart's HISTORY_PAGE, TradesList's TRADES_PAGE_SIZE, ShipLogCard's
  // LOG_PAGE_SIZE) and lazy-load older from IDB on scroll, so keeping
  // any more than this in memory is wasted heap.
  const HISTORY_KEEP = 100;
  const TRADES_KEEP = 100;
  const LOG_KEEP = 100;
  const LEDGER_KEEP = 100;
  const SPOT_KEEP = 100;
  try {
    await Promise.all([
      history.length > 0 ? putHistory(history).then(() => {
        historyHighWater.set(gameId, maxH);
        for (const eq of Object.values(world.equities ?? {})) {
          if (eq.history && eq.history.length > HISTORY_KEEP) {
            eq.history.splice(0, eq.history.length - HISTORY_KEEP);
          }
        }
      }) : Promise.resolve(),
      trades.length > 0 ? putTrades(trades).then(() => {
        tradesHighWater.set(gameId, maxT);
        for (const eq of Object.values(world.equities ?? {})) {
          if (eq.recentTrades && eq.recentTrades.length > TRADES_KEEP) {
            eq.recentTrades.splice(0, eq.recentTrades.length - TRADES_KEEP);
          }
        }
      }) : Promise.resolve(),
      log.length > 0 ? putLog(log).then(() => {
        logHighWater.set(gameId, maxL);
        for (const trader of Object.values(world.traders ?? {})) {
          if (trader.log && trader.log.length > LOG_KEEP) {
            trader.log.splice(0, trader.log.length - LOG_KEEP);
          }
        }
      }) : Promise.resolve(),
      ledger.length > 0 ? putTradeRecords(ledger).then(() => {
        ledgerHighWater.set(gameId, maxLedger);
        for (const trader of Object.values(world.traders ?? {})) {
          if (trader.stockTrades && trader.stockTrades.length > LEDGER_KEEP) {
            trader.stockTrades.splice(0, trader.stockTrades.length - LEDGER_KEEP);
          }
        }
      }) : Promise.resolve(),
      news.length > 0 ? putNewsEvents(news).then(() => {
        newsHighWater.set(gameId, maxNews);
        // No in-memory trim — news.recent is already capped at 64 by
        // tickNewsEvents; that's our display window.
      }) : Promise.resolve(),
      spot.length > 0 ? putSpotHistory(spot).then(() => {
        spotHighWater.set(gameId, maxSpot);
        if (world.commoditySpotHistory) {
          for (const ring of Object.values(world.commoditySpotHistory)) {
            if (ring.length > SPOT_KEEP) ring.splice(0, ring.length - SPOT_KEEP);
          }
        }
      }) : Promise.resolve(),
    ]);
  } catch (error) {
    console.warn("[ledgway] historyDb flush failed", error);
  }
}

// Set the high-water marks so the next flush only writes ticks past `tick`.
// Called on load after we've just hydrated the rings from IDB up through
// the snapshot's tick — there's nothing older to re-flush.
export function primeHighWater(gameId: string, tick: number): void {
  if (!gameId) return;
  historyHighWater.set(gameId, tick);
  tradesHighWater.set(gameId, tick);
  logHighWater.set(gameId, tick);
  ledgerHighWater.set(gameId, tick);
  newsHighWater.set(gameId, tick);
  spotHighWater.set(gameId, tick);
}

// Refill the in-memory rings on a freshly-loaded world. Pulls bounded
// windows that match the post-flush trim sizes (1000/500/200) — the
// rings are also the live chart/T&S/log buffers and unbounded heap was
// causing major GC pauses on every interaction. Anything older is still
// in IndexedDB and gets fetched lazily by the chart's overpan
// subscription. Filters to tick <= world.tick so a save snapshot at
// tick T never sees data from a later session that didn't get re-saved.
export async function hydrateHistoryRings(
  world: World,
  opts?: { historyLimit?: number; tradesLimit?: number; logLimit?: number; ledgerLimit?: number; newsLimit?: number },
): Promise<void> {
  const gameId = world.gameId;
  if (!gameId) return;
  const historyLimit = opts?.historyLimit ?? 100;
  const tradesLimit = opts?.tradesLimit ?? 100;
  const logLimit = opts?.logLimit ?? 100;
  const ledgerLimit = opts?.ledgerLimit ?? 100;
  const newsLimit = opts?.newsLimit ?? 64;
  const snapshotTick = world.tick;

  // Wait for any in-flight flush to settle before reading. Without this, a
  // fresh-world save followed by an immediate hydrate could race and overwrite
  // the rings with empty data.
  const pending = pendingFlushes.get(gameId);
  if (pending) {
    try { await pending; } catch { /* failure already logged in doFlush */ }
  }

  const equityIds = Object.keys(world.equities ?? {});
  const traderIds = Object.keys(world.traders ?? {});
  const goodIds = Object.keys(world.goods ?? {});
  const spotLimit = opts?.historyLimit ?? 100;

  await Promise.all([
    ...equityIds.map(async (eqId) => {
      const eq: Equity | undefined = world.equities[eqId];
      if (!eq) return;
      const samples = await getRecentHistory(gameId, eqId, historyLimit);
      eq.history = samples
        .filter(s => s.tick <= snapshotTick)
        .map(s => ({ tick: s.tick, price: s.price }));
    }),
    ...equityIds.map(async (eqId) => {
      const eq: Equity | undefined = world.equities[eqId];
      if (!eq) return;
      const trades = await getRecentTrades(gameId, eqId, tradesLimit);
      eq.recentTrades = trades.filter(t => t.tick <= snapshotTick).map(trimToTrade);
    }),
    ...traderIds.map(async (tId) => {
      const trader = world.traders[tId];
      if (!trader) return;
      const entries = await getRecentLog(gameId, tId, logLimit);
      trader.log = entries.filter(e => e.tick <= snapshotTick).map(trimToLog);
    }),
    ...(world.player?.shipIds ?? []).map(async (shipId) => {
      const trader = world.traders[shipId];
      if (!trader) return;
      const records = await getRecentTradeRecords(gameId, shipId, ledgerLimit);
      trader.stockTrades = records.filter(r => r.tick <= snapshotTick).map(trimToTradeRecord);
    }),
    (async () => {
      if (!world.newsEvents) return;
      const events = await getRecentNewsEvents(gameId, newsLimit);
      world.newsEvents.recent = events
        .filter(e => e.tick <= snapshotTick)
        .map(e => ({ uid: e.uid, templateId: e.templateId, tick: e.tick, effects: e.effects }));
    })(),
    ...goodIds.map(async (goodId) => {
      if (!world.commoditySpotHistory) world.commoditySpotHistory = {};
      const samples = await getRecentSpotHistory(gameId, goodId, spotLimit, snapshotTick);
      world.commoditySpotHistory[goodId] = samples.map(s => ({ tick: s.tick, price: s.price }));
    }),
  ]);

  primeHighWater(gameId, snapshotTick);
}

function trimToTrade(t: PersistedTrade): BookTrade {
  const trade: BookTrade = {
    equityId: t.equityId,
    qty: t.qty,
    price: t.price,
    buyer: t.buyer,
    seller: t.seller,
    takerSide: t.takerSide,
    tick: t.tick,
  };
  if (t.buyerLimitPrice !== undefined) trade.buyerLimitPrice = t.buyerLimitPrice;
  if (t.sellerLimitPrice !== undefined) trade.sellerLimitPrice = t.sellerLimitPrice;
  return trade;
}

function trimToLog(e: PersistedLogEntry): ShipLogEntry {
  const entry: ShipLogEntry = { tick: e.tick, kind: e.kind, message: e.message };
  if (e.tone !== undefined) entry.tone = e.tone;
  return entry;
}

function trimToTradeRecord(r: PersistedTradeRecord): TradeRecord {
  const record: TradeRecord = {
    id: r.id,
    tick: r.tick,
    equityId: r.equityId,
    ticker: r.ticker,
    action: r.action,
    shares: r.shares,
    price: r.price,
    fee: r.fee,
    cashFlow: r.cashFlow,
  };
  if (r.realizedPnl !== undefined) record.realizedPnl = r.realizedPnl;
  if (r.trigger !== undefined) record.trigger = r.trigger;
  return record;
}

// --- reads ------------------------------------------------------------------

// Read the most recent N history samples for an equity, in tick order
// (oldest first — matches the in-memory ring's append order).
export async function getRecentHistory(gameId: string, equityId: EquityId, limit: number): Promise<HistorySample[]> {
  if (limit <= 0) return [];
  const db = await openHistoryDb();
  if (!db) return [];
  const tx = db.transaction(STORE_HISTORY, "readonly");
  const store = tx.objectStore(STORE_HISTORY);
  const range = IDBKeyRange.bound(
    [gameId, equityId, Number.NEGATIVE_INFINITY],
    [gameId, equityId, Number.POSITIVE_INFINITY],
  );
  const out: HistorySample[] = [];
  return new Promise<HistorySample[]>((resolve, reject) => {
    const req = store.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value as HistorySample);
        cursor.continue();
      } else {
        out.reverse();
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// Read the most recent N universe-spot samples for a good, oldest-first.
// `atOrBeforeTick` (default ∞) clamps the upper bound at IDB query time so
// hydrate after a load doesn't pick up samples written by a later session
// that ran past the snapshot tick.
export async function getRecentSpotHistory(
  gameId: string,
  goodId: GoodId,
  limit: number,
  atOrBeforeTick: number = Number.POSITIVE_INFINITY,
): Promise<SpotHistorySample[]> {
  if (limit <= 0) return [];
  const db = await openHistoryDb();
  if (!db) return [];
  const tx = db.transaction(STORE_SPOT_HISTORY, "readonly");
  const store = tx.objectStore(STORE_SPOT_HISTORY);
  const range = IDBKeyRange.bound(
    [gameId, goodId, Number.NEGATIVE_INFINITY],
    [gameId, goodId, atOrBeforeTick],
  );
  const out: SpotHistorySample[] = [];
  return new Promise<SpotHistorySample[]>((resolve, reject) => {
    const req = store.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value as SpotHistorySample);
        cursor.continue();
      } else {
        out.reverse();
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// Inclusive [fromTick, toTick] window for a good — used by chart pan-left
// lazy backfill, mirroring getHistoryWindow.
export async function getSpotHistoryWindow(
  gameId: string,
  goodId: GoodId,
  fromTick: number,
  toTick: number,
): Promise<SpotHistorySample[]> {
  if (toTick < fromTick) return [];
  const db = await openHistoryDb();
  if (!db) return [];
  const tx = db.transaction(STORE_SPOT_HISTORY, "readonly");
  const store = tx.objectStore(STORE_SPOT_HISTORY);
  const range = IDBKeyRange.bound([gameId, goodId, fromTick], [gameId, goodId, toTick]);
  const out: SpotHistorySample[] = [];
  return new Promise<SpotHistorySample[]>((resolve, reject) => {
    const req = store.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.push(cursor.value as SpotHistorySample);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// Read a tick window (inclusive) for an equity. Used by lazy chart backfill
// when the player scrolls past the in-memory ring.
export async function getHistoryWindow(
  gameId: string,
  equityId: EquityId,
  fromTick: number,
  toTick: number,
): Promise<HistorySample[]> {
  if (toTick < fromTick) return [];
  const db = await openHistoryDb();
  if (!db) return [];
  const tx = db.transaction(STORE_HISTORY, "readonly");
  const store = tx.objectStore(STORE_HISTORY);
  const range = IDBKeyRange.bound([gameId, equityId, fromTick], [gameId, equityId, toTick]);
  const out: HistorySample[] = [];
  return new Promise<HistorySample[]>((resolve, reject) => {
    const req = store.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        out.push(cursor.value as HistorySample);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getRecentTrades(gameId: string, equityId: EquityId, limit: number): Promise<PersistedTrade[]> {
  if (limit <= 0) return [];
  const db = await openHistoryDb();
  if (!db) return [];
  const tx = db.transaction(STORE_TRADES, "readonly");
  const idx = tx.objectStore(STORE_TRADES).index(IDX_TRADES);
  const range = IDBKeyRange.bound(
    [gameId, equityId, Number.NEGATIVE_INFINITY],
    [gameId, equityId, Number.POSITIVE_INFINITY],
  );
  const out: PersistedTrade[] = [];
  return new Promise<PersistedTrade[]>((resolve, reject) => {
    const req = idx.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value as PersistedTrade);
        cursor.continue();
      } else {
        out.reverse();
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function getRecentLog(gameId: string, traderId: TraderId, limit: number): Promise<PersistedLogEntry[]> {
  if (limit <= 0) return [];
  const db = await openHistoryDb();
  if (!db) return [];
  const tx = db.transaction(STORE_LOG, "readonly");
  const idx = tx.objectStore(STORE_LOG).index(IDX_LOG);
  const range = IDBKeyRange.bound(
    [gameId, traderId, Number.NEGATIVE_INFINITY],
    [gameId, traderId, Number.POSITIVE_INFINITY],
  );
  const out: PersistedLogEntry[] = [];
  return new Promise<PersistedLogEntry[]>((resolve, reject) => {
    const req = idx.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value as PersistedLogEntry);
        cursor.continue();
      } else {
        out.reverse();
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// Older trader-log entries, newest-first within the queried range, used by
// the Ledger Log lazy pagination once the user scrolls past the in-memory
// window. Mirrors getTradeRecordsBefore — pass `beforeTick` exclusive to
// fetch the next older chunk.
export async function getLogEntriesBefore(
  gameId: string,
  traderId: TraderId,
  beforeTick: number,
  limit: number,
): Promise<PersistedLogEntry[]> {
  if (limit <= 0) return [];
  const db = await openHistoryDb();
  if (!db) return [];
  const tx = db.transaction(STORE_LOG, "readonly");
  const idx = tx.objectStore(STORE_LOG).index(IDX_LOG);
  const range = IDBKeyRange.bound(
    [gameId, traderId, Number.NEGATIVE_INFINITY],
    [gameId, traderId, beforeTick],
    false,
    true,
  );
  const out: PersistedLogEntry[] = [];
  return new Promise<PersistedLogEntry[]>((resolve, reject) => {
    const req = idx.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value as PersistedLogEntry);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// Per-ship trade ledger query — used by hydrate to repopulate ship.stockTrades.
export async function getRecentTradeRecords(gameId: string, shipId: TraderId, limit: number): Promise<PersistedTradeRecord[]> {
  if (limit <= 0) return [];
  const db = await openHistoryDb();
  if (!db) return [];
  const tx = db.transaction(STORE_LEDGER, "readonly");
  const idx = tx.objectStore(STORE_LEDGER).index(IDX_LEDGER_SHIP);
  const range = IDBKeyRange.bound(
    [gameId, shipId, Number.NEGATIVE_INFINITY],
    [gameId, shipId, Number.POSITIVE_INFINITY],
  );
  const out: PersistedTradeRecord[] = [];
  return new Promise<PersistedTradeRecord[]>((resolve, reject) => {
    const req = idx.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value as PersistedTradeRecord);
        cursor.continue();
      } else {
        out.reverse();
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// Total number of trade records persisted for this game. Used by the
// History tab badge — the in-memory ledger only sees the most recent
// ~100 entries, so without this the badge under-reports once the
// ledger has been flushed and trimmed. Pass `shipId` to scope the count
// to a single ship (matches the per-ship view in the Stock Exchange).
export async function countTradeRecords(gameId: string, shipId?: TraderId): Promise<number> {
  const db = await openHistoryDb();
  if (!db) return 0;
  const tx = db.transaction(STORE_LEDGER, "readonly");
  if (shipId != null) {
    const idx = tx.objectStore(STORE_LEDGER).index(IDX_LEDGER_SHIP);
    const range = IDBKeyRange.bound(
      [gameId, shipId, Number.NEGATIVE_INFINITY],
      [gameId, shipId, Number.POSITIVE_INFINITY],
    );
    return reqAsPromise(idx.count(range));
  }
  const idx = tx.objectStore(STORE_LEDGER).index(IDX_LEDGER_GAME);
  const range = IDBKeyRange.bound([gameId, Number.NEGATIVE_INFINITY], [gameId, Number.POSITIVE_INFINITY]);
  return reqAsPromise(idx.count(range));
}

// Most recent news events for this game, oldest-first within the window.
// Used by hydrate to refill state.recent.
export async function getRecentNewsEvents(gameId: string, limit: number): Promise<PersistedNewsEvent[]> {
  if (limit <= 0) return [];
  const db = await openHistoryDb();
  if (!db) return [];
  const tx = db.transaction(STORE_NEWS, "readonly");
  const idx = tx.objectStore(STORE_NEWS).index(IDX_NEWS_GAME);
  const range = IDBKeyRange.bound([gameId, Number.NEGATIVE_INFINITY], [gameId, Number.POSITIVE_INFINITY]);
  const out: PersistedNewsEvent[] = [];
  return new Promise<PersistedNewsEvent[]>((resolve, reject) => {
    const req = idx.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value as PersistedNewsEvent);
        cursor.continue();
      } else {
        out.reverse();
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// Paginate older news events for a future archive UI.
export async function getNewsEventsBefore(
  gameId: string,
  beforeTick: number,
  limit: number,
): Promise<PersistedNewsEvent[]> {
  if (limit <= 0) return [];
  const db = await openHistoryDb();
  if (!db) return [];
  const tx = db.transaction(STORE_NEWS, "readonly");
  const idx = tx.objectStore(STORE_NEWS).index(IDX_NEWS_GAME);
  const range = IDBKeyRange.bound(
    [gameId, Number.NEGATIVE_INFINITY],
    [gameId, beforeTick],
    false,
    true,
  );
  const out: PersistedNewsEvent[] = [];
  return new Promise<PersistedNewsEvent[]>((resolve, reject) => {
    const req = idx.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value as PersistedNewsEvent);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// Per-ship "older trades, newest-first" query — used by the per-ship
// History tab to lazy-load past the in-memory window.
export async function getTradeRecordsBeforeForShip(
  gameId: string,
  shipId: TraderId,
  beforeTick: number,
  limit: number,
): Promise<PersistedTradeRecord[]> {
  if (limit <= 0) return [];
  const db = await openHistoryDb();
  if (!db) return [];
  const tx = db.transaction(STORE_LEDGER, "readonly");
  const idx = tx.objectStore(STORE_LEDGER).index(IDX_LEDGER_SHIP);
  const range = IDBKeyRange.bound(
    [gameId, shipId, Number.NEGATIVE_INFINITY],
    [gameId, shipId, beforeTick],
    false,
    true,
  );
  const out: PersistedTradeRecord[] = [];
  return new Promise<PersistedTradeRecord[]>((resolve, reject) => {
    const req = idx.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value as PersistedTradeRecord);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// Cross-ship "all trades for this game" query — used by the Ledger Log
// to lazy-load older trades. Returns newest-first; callers can paginate by
// passing `beforeTick` to fetch the next older chunk.
export async function getTradeRecordsBefore(
  gameId: string,
  beforeTick: number,
  limit: number,
): Promise<PersistedTradeRecord[]> {
  if (limit <= 0) return [];
  const db = await openHistoryDb();
  if (!db) return [];
  const tx = db.transaction(STORE_LEDGER, "readonly");
  const idx = tx.objectStore(STORE_LEDGER).index(IDX_LEDGER_GAME);
  // Open-ended on the high side — `beforeTick` is exclusive.
  const range = IDBKeyRange.bound(
    [gameId, Number.NEGATIVE_INFINITY],
    [gameId, beforeTick],
    false,
    true,
  );
  const out: PersistedTradeRecord[] = [];
  return new Promise<PersistedTradeRecord[]>((resolve, reject) => {
    const req = idx.openCursor(range, "prev");
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && out.length < limit) {
        out.push(cursor.value as PersistedTradeRecord);
        cursor.continue();
      } else {
        resolve(out);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// --- delete -----------------------------------------------------------------

export async function deleteGame(gameId: string): Promise<void> {
  if (!gameId) return;
  const db = await openHistoryDb();
  if (!db) return;
  const tx = db.transaction([STORE_HISTORY, STORE_TRADES, STORE_LOG, STORE_LEDGER, STORE_NEWS, STORE_SPOT_HISTORY], "readwrite");
  await Promise.all([
    deleteByGameId(tx.objectStore(STORE_HISTORY), gameId, "history"),
    deleteByGameId(tx.objectStore(STORE_TRADES), gameId, "trades"),
    deleteByGameId(tx.objectStore(STORE_LOG), gameId, "log"),
    deleteByGameId(tx.objectStore(STORE_LEDGER), gameId, "ledger"),
    deleteByGameId(tx.objectStore(STORE_NEWS), gameId, "news"),
    deleteByGameId(tx.objectStore(STORE_SPOT_HISTORY), gameId, "spot"),
  ]);
  await txDone(tx);
  historyHighWater.delete(gameId);
  tradesHighWater.delete(gameId);
  logHighWater.delete(gameId);
  ledgerHighWater.delete(gameId);
  newsHighWater.delete(gameId);
  spotHighWater.delete(gameId);
}

function deleteByGameId(
  store: IDBObjectStore,
  gameId: string,
  kind: "history" | "trades" | "log" | "ledger" | "news" | "spot",
): Promise<void> {
  // history + news + spot use compound primary keys whose first element is
  // gameId; range-delete on the primary key directly. The auto-key /
  // id-key stores walk the matching index and call cursor.delete() row by
  // row.
  if (kind === "history" || kind === "spot") {
    const range = IDBKeyRange.bound(
      [gameId, "", Number.NEGATIVE_INFINITY],
      [gameId, "￿", Number.POSITIVE_INFINITY],
    );
    return reqAsPromise(store.delete(range)).then(() => undefined);
  }
  if (kind === "news") {
    const range = IDBKeyRange.bound([gameId, ""], [gameId, "￿"]);
    return reqAsPromise(store.delete(range)).then(() => undefined);
  }
  const indexName = kind === "trades" ? IDX_TRADES
    : kind === "log" ? IDX_LOG
    : IDX_LEDGER_GAME;
  const idx = store.index(indexName);
  // trades/log indexes are [gameId, equityId|traderId, tick] (3-tuple);
  // ledger byGameTick is [gameId, tick] (2-tuple). Build matching ranges.
  const range = kind === "ledger"
    ? IDBKeyRange.bound([gameId, Number.NEGATIVE_INFINITY], [gameId, Number.POSITIVE_INFINITY])
    : IDBKeyRange.bound(
        [gameId, "", Number.NEGATIVE_INFINITY],
        [gameId, "￿", Number.POSITIVE_INFINITY],
      );
  return new Promise<void>((resolve, reject) => {
    const req = idx.openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      } else {
        resolve();
      }
    };
    req.onerror = () => reject(req.error);
  });
}

// ----- save world payloads --------------------------------------------------
//
// World JSON for save slots used to live in localStorage alongside the
// summary registry. With cargo lots, positions, and contracts piling up
// during a long run, single-save payloads can exceed 1.5 MB — past the
// per-origin localStorage cap. We keep the small summary in localStorage
// (so cold-start can render the save list synchronously) and stash the
// world body here in IDB.

export async function putSaveWorld(saveId: string, world: World): Promise<void> {
  if (!saveId) return;
  const db = await openHistoryDb();
  if (!db) return;
  const tx = db.transaction(STORE_SAVE_WORLDS, "readwrite");
  await reqAsPromise(tx.objectStore(STORE_SAVE_WORLDS).put(world, saveId));
  await txDone(tx);
}

export async function getSaveWorld(saveId: string): Promise<World | null> {
  if (!saveId) return null;
  const db = await openHistoryDb();
  if (!db) return null;
  const tx = db.transaction(STORE_SAVE_WORLDS, "readonly");
  const result = await reqAsPromise<World | undefined>(tx.objectStore(STORE_SAVE_WORLDS).get(saveId));
  await txDone(tx);
  return result ?? null;
}

export async function deleteSaveWorld(saveId: string): Promise<void> {
  if (!saveId) return;
  const db = await openHistoryDb();
  if (!db) return;
  const tx = db.transaction(STORE_SAVE_WORLDS, "readwrite");
  await reqAsPromise(tx.objectStore(STORE_SAVE_WORLDS).delete(saveId));
  await txDone(tx);
}
