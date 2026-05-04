// Ledger view — two side-by-side panels within the standard page bounds:
//
//   Left (wider): tabbed sub-panels.
//     - Charters: combined milestone badges (guilds + licenses, all in
//       one carded grid). Rarity colors + EARNED stamps live here.
//     - Syndicates: per-syndicate reputation cards listing the player's
//       standing with each faction in this seed.
//
//   Right (narrower): the captain's ledger sidebar — flat ship-info-style
//     stat sections (career, wallet/fleet, activity placeholders, save
//     info). Same on both sub-tabs.

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { IconType } from "react-icons";
import {
  GiAstronautHelmet,
  GiAutoRepair,
  GiCargoCrate,
  GiCrossedSwords,
  GiFactory,
  GiHelmet,
  GiPathDistance,
  GiProcessor,
} from "react-icons/gi";
import type { Encounter, ShipLogEntry, ShipLogTone, Syndicate, TradeRecord, Trader, World } from "../../sim/types";
import { useStore } from "../store";
import { useIsMobile } from "../useIsMobile";
import { defaultMobilePanelId } from "../mobilePanels";
import { getLogEntriesBefore, getTradeRecordsBefore } from "../historyDb";
import { listMilestoneProgress, type MilestoneKey, type MilestoneProgress } from "../../sim/milestones";
import { SYNDICATE_TRAITS } from "../../sim/data/syndicates";
import { playerReputationWith } from "../../sim/control";
import { useSyndicateInsigniaImageUrl } from "../syndicateInsigniaApi";
import { headerArtUrl } from "../art";
import "./ChartersView.css";

const MILESTONE_ICONS: Record<MilestoneKey, IconType> = {
  upgradeTier1:    GiCargoCrate,
  upgradeTier2:    GiFactory,
  upgradeTier3:    GiProcessor,
  upgradeTier4:    GiCrossedSwords,
  navigatorOffers: GiPathDistance,
  mechanicOffers:  GiAutoRepair,
  captainOffers:   GiAstronautHelmet,
  mercenaryOffers: GiHelmet,
};

function milestoneRarity(key: MilestoneKey): "common" | "uncommon" | "rare" | "legendary" {
  if (key === "upgradeTier1") return "common";
  if (key === "upgradeTier2" || key === "navigatorOffers" || key === "mechanicOffers") return "uncommon";
  if (key === "upgradeTier3" || key === "captainOffers" || key === "mercenaryOffers") return "rare";
  return "legendary";
}

function milestoneCategory(key: MilestoneKey): "license" | "guild" {
  return key.startsWith("upgrade") ? "license" : "guild";
}

function artCardStyle(url: string): CSSProperties {
  return { "--card-art": `url("${url}")` } as CSSProperties;
}

export function ChartersView() {
  const world = useStore((s) => s.world);
  const ledgerTab = useStore((s) => s.ledgerTab);
  const setLedgerTab = useStore((s) => s.setLedgerTab);
  useStore((s) => s.tickEpoch);

  const progress = listMilestoneProgress(world);
  const earned = progress.filter(p => p.met).length;
  const total = progress.length;
  const totalActions = world.player?.manualActionCount ?? 0;

  const next = progress
    .filter(p => !p.met)
    .sort((a, b) => (a.target - a.current) - (b.target - b.current))[0] ?? null;

  const syndicates = Object.values(world.syndicates).sort((a, b) => a.id.localeCompare(b.id));
  const playerShips = (world.player?.shipIds ?? [])
    .map(id => world.traders[id])
    .filter((t): t is Trader => Boolean(t));
  const encounterCount = world.encounterHistory?.length ?? 0;
  // Count ship.log + ship.stockTrades — the Ledger Log feed shows both,
  // so the badge needs to reflect both. Older archived entries live in
  // IDB and are paginated in lazily.
  const logEntryCount = playerShips.reduce(
    (s, t) => s + (t.log?.length ?? 0) + (t.stockTrades?.length ?? 0),
    0,
  );
  const isMobile = useIsMobile();
  const mobilePanel = useStore(s => s.mobilePanel.charters ?? defaultMobilePanelId("charters") ?? "records");

  return (
    <section
      className={`charters-view ${isMobile ? "mobile" : ""}`}
      data-mobile-panel={isMobile ? mobilePanel : undefined}
    >
      {/* Left (wider): tabbed sub-panels — Charters (combined milestones),
          Syndicates (per-faction reputation cards), or Log (consolidated
          fleet history feed). */}
      <section className="charters-badges-card">
        <div className="bridge-card-tabs charters-badges-tabs">
          <button
            type="button"
            className={`bridge-tab ${ledgerTab === "charters" ? "active" : ""}`}
            onClick={() => setLedgerTab("charters")}
          >
            Charters <span className="bridge-tab-count">{earned}/{total}</span>
          </button>
          <button
            type="button"
            className={`bridge-tab ${ledgerTab === "syndicates" ? "active" : ""}`}
            onClick={() => setLedgerTab("syndicates")}
          >
            Syndicates <span className="bridge-tab-count">{syndicates.length}</span>
          </button>
          <button
            type="button"
            className={`bridge-tab ${ledgerTab === "combat" ? "active" : ""}`}
            onClick={() => setLedgerTab("combat")}
          >
            Combat <span className="bridge-tab-count">{encounterCount}</span>
          </button>
          <button
            type="button"
            className={`bridge-tab ${ledgerTab === "log" ? "active" : ""}`}
            onClick={() => setLedgerTab("log")}
          >
            Log <span className="bridge-tab-count">{logEntryCount}</span>
          </button>
        </div>
        {ledgerTab === "charters" && <ChartersTabBody world={world} progress={progress} />}
        {ledgerTab === "syndicates" && <SyndicatesTabBody world={world} syndicates={syndicates} />}
        {ledgerTab === "combat" && <CombatTabBody world={world} />}
        {ledgerTab === "log" && <LogTabBody ships={playerShips} />}
      </section>

      {/* Right (narrower): captain's ledger sidebar — career stats,
          wallet/fleet totals, save info. Stays consistent across sub-tabs. */}
      <CaptainsLedgerSidebar
        world={world}
        totalActions={totalActions}
        earned={earned}
        total={total}
        next={next}
      />
    </section>
  );
}

// --- Log tab (fleet history feed) -----------------------------------------

interface FleetLogEntry extends ShipLogEntry {
  shipId: string;
  shipName: string;
}

const FLEET_LOG_PAGE_SIZE = 100;

function LogTabBody({ ships }: { ships: Trader[] }) {
  const gameId = useStore(s => s.world.gameId);

  // Build the merged in-memory feed: per-ship log entries (ship.log: cargo
  // trades, travel, contract events) + stock-trade ledger entries
  // (ship.stockTrades: buys/sells/shorts/covers). Newest-first; secondary
  // by ship name groups same-tick entries per ship.
  const inMemory = useMemo(() => {
    const out: FleetLogEntry[] = [];
    for (const t of ships) {
      for (const e of t.log ?? []) {
        out.push({ ...e, shipId: t.id, shipName: t.name });
      }
      for (const record of t.stockTrades ?? []) {
        out.push({ ...formatTradeRecord(record), shipId: t.id, shipName: t.name });
      }
    }
    out.sort((a, b) => b.tick - a.tick || a.shipName.localeCompare(b.shipName));
    return out;
  }, [ships]);

  // Older entries pulled from IDB once the user scrolls past the in-memory
  // window. Reset whenever the game changes.
  const [olderEntries, setOlderEntries] = useState<FleetLogEntry[]>([]);
  const [exhausted, setExhausted] = useState(false);
  const fetchingRef = useRef(false);
  const sentinelRef = useRef<HTMLLIElement | null>(null);

  useEffect(() => {
    setOlderEntries([]);
    setExhausted(false);
    fetchingRef.current = false;
  }, [gameId]);

  const entries = olderEntries.length > 0 ? [...inMemory, ...olderEntries] : inMemory;

  useEffect(() => {
    if (exhausted || !gameId) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const obs = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || fetchingRef.current) return;
      const earliestTick = entries[entries.length - 1]?.tick;
      if (earliestTick == null) return;
      fetchingRef.current = true;
      const shipMap = new Map(ships.map(s => [s.id, s.name]));
      // Pull older log entries from each player ship + older trade records
      // across the whole game in parallel, then merge by tick.
      Promise.all([
        Promise.all(ships.map(t => getLogEntriesBefore(gameId, t.id, earliestTick, FLEET_LOG_PAGE_SIZE))),
        getTradeRecordsBefore(gameId, earliestTick, FLEET_LOG_PAGE_SIZE),
      ]).then(([logBatches, trades]) => {
        fetchingRef.current = false;
        const fetched: FleetLogEntry[] = [];
        for (let i = 0; i < ships.length; i++) {
          const shipId = ships[i].id;
          const shipName = shipMap.get(shipId) ?? shipId;
          for (const e of logBatches[i]) {
            fetched.push({
              tick: e.tick, kind: e.kind, message: e.message,
              ...(e.tone !== undefined ? { tone: e.tone } : {}),
              shipId, shipName,
            });
          }
        }
        for (const record of trades) {
          const shipId = record.shipId;
          const shipName = shipMap.get(shipId) ?? shipId;
          fetched.push({ ...formatTradeRecord(record), shipId, shipName });
        }
        if (fetched.length === 0) {
          setExhausted(true);
          return;
        }
        fetched.sort((a, b) => b.tick - a.tick || a.shipName.localeCompare(b.shipName));
        setOlderEntries(prev => [...prev, ...fetched]);
      }).catch(err => {
        fetchingRef.current = false;
        console.warn("[ledgway] fleet log backfill failed", err);
      });
    }, { rootMargin: "200px" });
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [entries, exhausted, gameId, ships]);

  const headArt = headerArtUrl("tradeLedger");
  return (
    <>
      <div className="charters-badges-head" style={artCardStyle(headArt)}>
        <div className="charters-badges-head-main">
          <span className="charters-badges-eyebrow">Fleet history feed</span>
          <span className="charters-badges-name">Log</span>
        </div>
        <div className="charters-badges-head-stat">
          <span className="charters-badges-head-stat-num mono">{entries.length}</span>
          <span className="charters-badges-head-stat-label">entries</span>
        </div>
      </div>
      <div className="charters-badges-body ledger-log-body" data-scroll-key="ledger:log">
        {entries.length === 0 ? (
          <p className="ledger-log-empty dim">No fleet activity recorded yet. Buy, sell, refuel, travel, or accept a contract — every action lands here.</p>
        ) : (
          <ol className="ledger-log-list">
            {entries.map((e, i) => (
              <li key={`${e.shipId}-${e.tick}-${i}`} className={`ledger-log-entry ${e.tone ? `tone-${e.tone}` : ""}`}>
                <span className="ledger-log-tick mono">t{e.tick}</span>
                <span className="ledger-log-ship" title={e.shipName}>{e.shipName}</span>
                <span className="ledger-log-kind">{kindLabel(e.kind)}</span>
                <span className="ledger-log-msg">{e.message}</span>
              </li>
            ))}
            {!exhausted && (
              <li ref={sentinelRef} className="ledger-log-loading dim">Loading older entries…</li>
            )}
          </ol>
        )}
      </div>
    </>
  );
}

function kindLabel(kind: string): string {
  return kind.replace(/_/g, " ");
}

// Format a stock-trade ledger entry as a fleet-log entry. The action verb
// + ticker + qty/price line up with the cargo log's "Bought X parts at
// Y" style; closes also surface the realized P&L.
function formatTradeRecord(record: TradeRecord): ShipLogEntry {
  const verb = record.action === "open_long" ? "Bought"
    : record.action === "add_long" ? "Added"
    : record.action === "close_long" ? "Sold"
    : record.action === "open_short" ? "Shorted"
    : record.action === "add_short" ? "Added short"
    : record.action === "cover_short" ? "Covered"
    : "Trade";
  const price = `Ç${record.price.toFixed(2)}`;
  const qty = record.shares.toLocaleString();
  let message = `${verb} ${qty} ${record.ticker} @ ${price}`;
  let tone: ShipLogTone | undefined;
  if (record.realizedPnl != null) {
    const pnl = record.realizedPnl;
    const sign = pnl >= 0 ? "+" : "";
    message += ` (${sign}Ç${Math.round(pnl).toLocaleString()})`;
    tone = pnl > 0 ? "good" : pnl < 0 ? "bad" : undefined;
  }
  if (record.trigger != null) {
    message += ` (auto: ${record.trigger.replace(/_/g, " ")})`;
  }
  return { tick: record.tick, kind: record.action, message, tone };
}

// --- Charters tab (combined milestone badges) -----------------------------

function ChartersTabBody({ world, progress }: { world: World; progress: MilestoneProgress[] }) {
  void world;
  const earned = progress.filter(p => p.met).length;
  const guilds = progress.filter(p => milestoneCategory(p.key) === "guild");
  const licenses = progress.filter(p => milestoneCategory(p.key) === "license");
  const headArt = headerArtUrl("tradeLedger");
  return (
    <>
      <div className="charters-badges-head" style={artCardStyle(headArt)}>
        <div className="charters-badges-head-main">
          <span className="charters-badges-eyebrow">Service charters & tier licenses</span>
          <span className="charters-badges-name">Charters</span>
        </div>
        <div className="charters-badges-head-stat">
          <span className="charters-badges-head-stat-num mono">{earned}<span className="charters-badges-head-stat-sep">/</span>{progress.length}</span>
          <span className="charters-badges-head-stat-label">earned</span>
        </div>
      </div>
      <div className="charters-badges-body" data-scroll-key="charters:combined">
        {guilds.length > 0 && (
          <>
            <div className="charters-section-title">Crew Guilds</div>
            <div className="charters-badges-grid">
              {guilds.map(m => <MilestoneBadge key={m.key} progress={m} />)}
            </div>
          </>
        )}
        {licenses.length > 0 && (
          <>
            <div className="charters-section-title">Tier Licenses</div>
            <div className="charters-badges-grid">
              {licenses.map(m => <MilestoneBadge key={m.key} progress={m} />)}
            </div>
          </>
        )}
      </div>
    </>
  );
}

// --- Syndicates tab (reputation per faction) ------------------------------

function SyndicatesTabBody({ world, syndicates }: { world: World; syndicates: Syndicate[] }) {
  const playerSyndicateId = world.traders[world.player?.shipIds[0] ?? ""]?.syndicateId;
  const headArt = headerArtUrl("crewMarket");
  return (
    <>
      <div className="charters-badges-head" style={artCardStyle(headArt)}>
        <div className="charters-badges-head-main">
          <span className="charters-badges-eyebrow">Faction standings · this seed</span>
          <span className="charters-badges-name">Syndicates</span>
        </div>
        <div className="charters-badges-head-stat">
          <span className="charters-badges-head-stat-num mono">{syndicates.length}</span>
          <span className="charters-badges-head-stat-label">factions</span>
        </div>
      </div>
      <div className="charters-badges-body" data-scroll-key="charters:syndicates">
        <div className="syndicate-rep-grid">
          {syndicates.map(s => (
            <SyndicateRepCard
              key={s.id}
              syndicate={s}
              isPlayer={s.id === playerSyndicateId}
              reputation={playerReputationWith(world, s.id)}
            />
          ))}
        </div>
      </div>
    </>
  );
}

function SyndicateRepCard({ syndicate, isPlayer, reputation }: {
  syndicate: Syndicate;
  isPlayer: boolean;
  reputation: number;
}) {
  const trait = syndicate.traitId ? SYNDICATE_TRAITS[syndicate.traitId] : null;
  const accent = syndicate.accentHex ?? "#9bb6c8";
  const insignia = useSyndicateInsigniaImageUrl(syndicate);
  // Effective reputation for the toll discount: the player's home
  // syndicate is implicitly 100% (toll never applies), even though
  // we don't store rep with own faction.
  const effectiveRep = isPlayer ? 1 : reputation;
  const repPct = Math.round(effectiveRep * 100);
  const repBand = effectiveRep >= 0.95 ? "trusted"
    : effectiveRep >= 0.6 ? "favoured"
    : effectiveRep >= 0.25 ? "known"
    : effectiveRep > 0 ? "neutral"
    : "stranger";
  return (
    <div
      className={`syndicate-rep-card ${isPlayer ? "is-player" : ""}`}
      style={{ "--syndicate-accent": accent } as CSSProperties}
    >
      <span className="syndicate-rep-card-swatch" aria-hidden="true" />
      {insignia.imageUrl && (
        <img
          className="syndicate-rep-card-insignia"
          src={insignia.imageUrl}
          alt=""
          aria-hidden="true"
        />
      )}
      <div className="syndicate-rep-card-content">
        <div className="syndicate-rep-card-head">
          <div className="syndicate-rep-card-titles">
            <div className="syndicate-rep-card-name">{syndicate.name}</div>
            {trait && <div className="syndicate-rep-card-trait">{trait.label}</div>}
          </div>
          {isPlayer && <span className="syndicate-rep-card-pill">Aligned</span>}
        </div>
        {trait && <div className="syndicate-rep-card-desc">{trait.description}</div>}
        <div className="syndicate-rep-card-track" title={isPlayer ? "Home syndicate — toll free" : `Reputation ${repPct}%`}>
          <div className="syndicate-rep-card-fill" style={{ width: `${effectiveRep * 100}%` } as CSSProperties} />
        </div>
        <div className="syndicate-rep-card-foot">
          <span className={`syndicate-rep-card-band band-${repBand}`}>{repBand}</span>
          <span className="syndicate-rep-card-pct mono">{repPct}%</span>
        </div>
      </div>
    </div>
  );
}

// --- Combat tab (encounter feed) ---------------------------------------

function CombatTabBody({ world }: { world: World }) {
  const [scope, setScope] = useState<"mine" | "all">("mine");
  const history = world.encounterHistory ?? [];
  const playerShipIds = useMemo(
    () => new Set(world.player?.shipIds ?? []),
    [world.player?.shipIds],
  );
  const filtered = useMemo(() => {
    if (scope === "all") return history;
    return history.filter(enc => playerShipIds.has(enc.shipId));
  }, [history, scope, playerShipIds]);
  // Newest-first within the chosen scope.
  const entries = useMemo(() => [...filtered].reverse(), [filtered]);
  const mineCount = useMemo(
    () => history.filter(enc => playerShipIds.has(enc.shipId)).length,
    [history, playerShipIds],
  );
  const headArt = headerArtUrl("contractBoard");
  return (
    <>
      <div className="charters-badges-head" style={artCardStyle(headArt)}>
        <div className="charters-badges-head-main">
          <span className="charters-badges-eyebrow">Hostile contacts · resolutions</span>
          <span className="charters-badges-name">Combat</span>
        </div>
        <div className="charters-badges-head-stat">
          <span className="charters-badges-head-stat-num mono">{filtered.length}</span>
          <span className="charters-badges-head-stat-label">encounters</span>
        </div>
      </div>
      <div className="charters-combat-scope">
        <button
          type="button"
          className={`bridge-tab ${scope === "mine" ? "active" : ""}`}
          onClick={() => setScope("mine")}
        >
          Mine <span className="bridge-tab-count">{mineCount}</span>
        </button>
        <button
          type="button"
          className={`bridge-tab ${scope === "all" ? "active" : ""}`}
          onClick={() => setScope("all")}
        >
          All ships <span className="bridge-tab-count">{history.length}</span>
        </button>
      </div>
      <div className="charters-badges-body ledger-log-body" data-scroll-key="ledger:combat">
        {entries.length === 0 ? (
          <p className="ledger-log-empty dim">
            {scope === "mine"
              ? "No combat on record. Encounters happen during transit — keep an eye out at borders, with valuable cargo, or in foreign territory."
              : "No fleet-wide combat yet. NPC raids start showing up here as ships start crossing busy lanes."}
          </p>
        ) : (
          <ol className="ledger-log-list">
            {entries.map((enc) => (
              <CombatEntry key={enc.id} world={world} encounter={enc} />
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

function CombatEntry({ world, encounter }: { world: World; encounter: Encounter }) {
  const r = encounter.resolution;
  const tone: ShipLogTone = !r ? "warn"
    : r.outcome === "won" || r.outcome === "escaped" ? "good"
    : r.outcome === "lost" || r.outcome === "negotiated_fail" ? "bad"
    : "warn";
  const ship = world.traders[encounter.shipId];
  const shipName = ship?.name ?? "—";
  const route = `${world.locations[encounter.fromLocation]?.name ?? encounter.fromLocation} → ${world.locations[encounter.toLocation]?.name ?? encounter.toLocation}`;
  const outcomeLabel = !r ? "pending" : OUTCOME_LABEL[r.outcome];
  const choiceLabel = !r ? "—" : r.choice;
  const lossText = (() => {
    if (!r?.loss) return "no losses";
    const parts: string[] = [];
    for (const c of r.loss.cargo) parts.push(`${c.qty} ${world.goods[c.good]?.name ?? c.good}`);
    if (r.loss.credits > 0) parts.push(`Ç${Math.round(r.loss.credits).toLocaleString()}`);
    if (r.loss.hull > 0) parts.push(`${r.loss.hull} hull`);
    return parts.length > 0 ? parts.join(", ") : "no losses";
  })();
  return (
    <li className={`ledger-log-entry tone-${tone}`}>
      <span className="ledger-log-tick mono">t{r?.tick ?? encounter.spawnedAt}</span>
      <span className="ledger-log-ship" title={shipName}>{shipName}</span>
      <span className="ledger-log-kind">{choiceLabel} · {outcomeLabel}</span>
      <span className="ledger-log-msg">
        {encounter.attacker.name} {route} — {lossText}
      </span>
    </li>
  );
}

const OUTCOME_LABEL: Record<NonNullable<Encounter["resolution"]>["outcome"], string> = {
  won: "won",
  lost: "lost",
  escaped: "escaped",
  fled_damaged: "fled, damaged",
  negotiated_peace: "talked down",
  negotiated_partial: "paid off",
  negotiated_fail: "negotiation failed",
};

// --- right-side player info panel -------------------------------------

interface SidebarProps {
  world: ReturnType<typeof useStore.getState>["world"];
  totalActions: number;
  earned: number;
  total: number;
  next: MilestoneProgress | null;
}

function CaptainsLedgerSidebar({ world, totalActions, earned, total, next }: SidebarProps) {
  const gameName = useStore((s) => s.gameName);
  const gameKind = useStore((s) => s.gameKind);

  const ships = world.player?.shipIds.map(id => world.traders[id]).filter(Boolean) ?? [];
  const wallet = ships.reduce((sum, s) => sum + (s?.funds ?? 0), 0);
  const flagship = ships[0];
  const ledgerArt = headerArtUrl("tradeLedger");

  // Markup mirrors ShipInfoPanelContent on the fleet view, plus an art-panel-head
  // splash above the body (same pattern stocks/markets/atlas use):
  //   .bridge-card .info-area-card wrapper
  //   .info-panel-frame column flex
  //   .charters-ledger-head .art-panel-head with art splash + title + pill
  //   .info-panel-fixed for the chip row beneath the splash
  //   .info-panel-scroll for the stat grid + sections
  return (
    <section className="bridge-card info-area-card charters-sidebar-card">
      <div className="info-panel-frame">
        <div
          className="charters-ledger-head art-panel-head"
          style={artCardStyle(ledgerArt)}
        >
          <div className="charters-ledger-head-main">
            <span className="charters-ledger-eyebrow">Career Progress</span>
            <span className="charters-ledger-name">Captain's Ledger</span>
          </div>
          <span className="station-kind-pill station-kind-frontier">
            {gameKind === "developer" ? "developer" : "standard"}
          </span>
        </div>

        <div className="info-panel-fixed">
          <div className="trade-helper-meta station-info-tags">
            <span>{flagship?.name ?? "No flagship"}</span>
            <span>{gameName}</span>
            <span>tick {world.tick.toLocaleString()}</span>
          </div>
        </div>

        <div className="info-panel-scroll" data-scroll-key="charters:ledger">
          <dl className="trade-helper-grid station-info-grid">
            <Stat label="manual actions" value={totalActions.toLocaleString()} />
            <Stat label="charters" value={`${earned} / ${total}`} />
            <Stat label="next at" value={next ? next.target.toLocaleString() : "—"} />
            <Stat label="wallet" value={`Ç${Math.round(wallet).toLocaleString()}`} />
            <Stat label="ships" value={ships.length.toString()} />
            <Stat label="time played" value="—" />
          </dl>

          <div className="trade-helper-section">
            <div className="exchange-section-title">Activity</div>
            <div className="trade-helper-line muted">
              <span>Trades completed</span><span className="mono">—</span>
            </div>
            <div className="trade-helper-line muted">
              <span>Contracts completed</span><span className="mono">—</span>
            </div>
            <div className="trade-helper-line muted">
              <span>Distance traveled</span><span className="mono">—</span>
            </div>
            <div className="trade-helper-line muted">
              <span>Stations visited</span><span className="mono">—</span>
            </div>
          </div>

          <div className="trade-helper-section">
            <div className="exchange-section-title">Recruitment</div>
            <div className="trade-helper-line muted">
              <span>Crew hired</span><span className="mono">—</span>
            </div>
            <div className="trade-helper-line muted">
              <span>Upgrades installed</span><span className="mono">—</span>
            </div>
          </div>

          <div className="trade-helper-section">
            <div className="exchange-section-title">Treasury</div>
            <div className="trade-helper-line muted">
              <span>Net worth</span><span className="mono">—</span>
            </div>
            <div className="trade-helper-line muted">
              <span>Cash flow / tick</span><span className="mono">—</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// Mirrors the Stat helper in PlayerView.tsx so the dl items render with the
// same .cargo-stat / .info-value class hooks.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="cargo-stat">
      <dt className="dim">{label}</dt>
      <dd key={value} className="mono info-value">{value}</dd>
    </div>
  );
}

// --- top-panel charter card (badge style — keeps rarity colors here only)

function MilestoneBadge({ progress }: { progress: MilestoneProgress }) {
  const Icon = MILESTONE_ICONS[progress.key];
  const fillPct = Math.min(100, (progress.current / Math.max(1, progress.target)) * 100);
  const remaining = Math.max(0, progress.target - progress.current);
  const rarity = milestoneRarity(progress.key);
  return (
    <div className={`milestone-badge rarity-${rarity} ${progress.met ? "earned" : "locked"}`}>
      <div className="milestone-emblem" aria-hidden="true">
        <Icon className="milestone-emblem-icon" />
        {progress.met && <span className="milestone-stamp">EARNED</span>}
      </div>
      <div className="milestone-body">
        <div className="milestone-name">{progress.label}</div>
        <div className="milestone-desc">{progress.description}</div>
        {progress.met ? (
          <div className="milestone-bar-row">
            <span className="milestone-state-met">UNLOCKED</span>
            <span className="milestone-target-cap">at {progress.target.toLocaleString()} actions</span>
          </div>
        ) : (
          <div className="milestone-bar-row">
            <div className="milestone-bar">
              <div className="milestone-bar-fill" style={{ width: `${fillPct.toFixed(1)}%` }} />
            </div>
            <span className="milestone-bar-text">
              <span className="milestone-bar-curr">{progress.current.toLocaleString()}</span>
              <span className="milestone-bar-sep">/</span>
              <span className="milestone-bar-target">{progress.target.toLocaleString()}</span>
              <span className="milestone-bar-remaining">−{remaining.toLocaleString()}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
