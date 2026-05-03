import type { BookTrade, Equity, EquityId, ShipLogEntry, TraderId, World } from "../sim/types";

const DB_NAME = "logics-history";
const DB_VERSION = 1;
const STORE_HISTORY = "equityHistory";
const STORE_TRADES = "equityTrades";
const STORE_LOG = "traderLog";
const IDX_TRADES = "byEquityTick";
const IDX_LOG = "byTraderTick";

export interface HistorySample {
  gameId: string;
  equityId: EquityId;
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

// Per-(gameId) high-water marks. We only flush samples with tick > the mark
// to avoid re-writing on every save. Reset implicitly on page reload — load
// re-seeds these to world.tick before any new samples can be appended.
const historyHighWater = new Map<string, number>();
const tradesHighWater = new Map<string, number>();
const logHighWater = new Map<string, number>();

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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      console.warn("[logics] historyDb open failed", req.error);
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

  const history: HistorySample[] = [];
  const trades: PersistedTrade[] = [];
  const log: PersistedLogEntry[] = [];

  let maxH = lastH, maxT = lastT, maxL = lastL;

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
    if (!trader.log) continue;
    for (const entry of trader.log) {
      if (entry.tick > lastL) {
        log.push({ ...entry, gameId, traderId: trader.id });
        if (entry.tick > maxL) maxL = entry.tick;
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
  const HISTORY_KEEP = 1000;
  const TRADES_KEEP = 500;
  const LOG_KEEP = 200;
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
    ]);
  } catch (error) {
    console.warn("[logics] historyDb flush failed", error);
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
  opts?: { historyLimit?: number; tradesLimit?: number; logLimit?: number },
): Promise<void> {
  const gameId = world.gameId;
  if (!gameId) return;
  const historyLimit = opts?.historyLimit ?? 1000;
  const tradesLimit = opts?.tradesLimit ?? 500;
  const logLimit = opts?.logLimit ?? 200;
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

// --- delete -----------------------------------------------------------------

export async function deleteGame(gameId: string): Promise<void> {
  if (!gameId) return;
  const db = await openHistoryDb();
  if (!db) return;
  const tx = db.transaction([STORE_HISTORY, STORE_TRADES, STORE_LOG], "readwrite");
  await Promise.all([
    deleteByGameId(tx.objectStore(STORE_HISTORY), gameId, "primary"),
    deleteByGameId(tx.objectStore(STORE_TRADES), gameId, "trades"),
    deleteByGameId(tx.objectStore(STORE_LOG), gameId, "log"),
  ]);
  await txDone(tx);
  historyHighWater.delete(gameId);
  tradesHighWater.delete(gameId);
  logHighWater.delete(gameId);
}

function deleteByGameId(store: IDBObjectStore, gameId: string, kind: "primary" | "trades" | "log"): Promise<void> {
  // History uses [gameId, equityId, tick] compound primary key — range-delete
  // on the primary key directly. Trades/log use auto-key, so we walk the
  // matching index and call cursor.delete() row by row.
  if (kind === "primary") {
    const range = IDBKeyRange.bound(
      [gameId, "", Number.NEGATIVE_INFINITY],
      [gameId, "￿", Number.POSITIVE_INFINITY],
    );
    return reqAsPromise(store.delete(range)).then(() => undefined);
  }
  const indexName = kind === "trades" ? IDX_TRADES : IDX_LOG;
  const idx = store.index(indexName);
  const range = IDBKeyRange.bound(
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
