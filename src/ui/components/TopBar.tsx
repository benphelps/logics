import { useRef, type ReactNode } from "react";
import { MdAdd, MdClose, MdCode, MdRestartAlt, MdSave } from "react-icons/md";
import type { IconType } from "react-icons";
import {
  GiBank,
  GiCargoCrate,
  GiContract,
  GiFactory,
  GiHabitatDome,
  GiPathDistance,
  GiRadarSweep,
  GiReceiveMoney,
  GiShipWheel,
  GiTrade,
  GiUpgrade,
  GiWallet,
} from "react-icons/gi";
import { useStore, type Speed, type Tab } from "../store";
import { hasCrew } from "../../sim/crew";
import { routeCount } from "../../sim/geometry";
import { listPositions, portfolioValue, totalUnrealizedPnl } from "../../sim/stock";
import type { World } from "../../sim/types";
import type { SaveSlotSummary } from "../saveGames";
import "./TopBar.css";

const SPEED_PRESETS: { value: Speed; label: string }[] = [
  { value: 0,  label: "Pause" },
  { value: 1,  label: "1×" },
  { value: 4,  label: "4×" },
  { value: 16, label: "16×" },
];

const TABS: { id: Tab; label: string }[] = [
  { id: "player", label: "My Fleet" },
  { id: "markets", label: "Markets" },
  { id: "locations", label: "Atlas" },
  { id: "stocks", label: "Exchange" },
];

export function TopBar() {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const selectedTab = useStore((s) => s.selectedTab);
  const selectTab = useStore((s) => s.selectTab);
  const selectedTrader = useStore((s) => s.selectedTrader);
  const selectTrader = useStore((s) => s.selectTrader);
  const speed = useStore((s) => s.speed);
  const setSpeed = useStore((s) => s.setSpeed);
  const step = useStore((s) => s.step);
  const setPilot = useStore((s) => s.setPilot);
  const reset = useStore((s) => s.reset);
  const saveCurrentGame = useStore((s) => s.saveCurrentGame);
  const createGame = useStore((s) => s.createGame);
  const loadGame = useStore((s) => s.loadGame);
  const deleteGame = useStore((s) => s.deleteGame);
  const loadDeveloperState = useStore((s) => s.loadDeveloperState);
  const activeSaveId = useStore((s) => s.activeSaveId);
  const gameName = useStore((s) => s.gameName);
  const gameKind = useStore((s) => s.gameKind);
  const saveSlots = useStore((s) => s.saveSlots);
  const saveStatus = useStore((s) => s.saveStatus);
  const world = useStore((s) => s.world);
  useStore((s) => s.tickEpoch);

  const tick = world.tick;
  const activeSlot = saveSlots.find(slot => slot.id === activeSaveId) ?? null;
  const playerShipIds = world.player?.shipIds ?? [];
  const playerShips = playerShipIds.map(id => world.traders[id]).filter(Boolean);
  const selectedShip = selectedTrader && playerShipIds.includes(selectedTrader)
    ? world.traders[selectedTrader] ?? playerShips[0] ?? null
    : playerShips[0] ?? null;
  const selectedShipId = selectedShip?.id ?? "";
  const autoBlocked = !!selectedShip && !hasCrew(selectedShip, "captain");
  const fleet = world.player
    ? world.player.shipIds.reduce((s, id) => s + (world.traders[id]?.funds ?? 0), 0)
    : 0;
  const pageSummary = selectedTab === "player" ? null : buildPageSummary(selectedTab, world, selectedShip?.funds ?? 0);
  const storageLabel = saveStatus === "saved" ? "Autosaved" : saveStatus === "unavailable" ? "Unsaved" : "Save error";
  const closeMenu = () => {
    if (menuRef.current) menuRef.current.open = false;
  };

  return (
    <section className="topbar-shell" aria-label="Game controls">
      <div className="topbar-nav-row">
        <div className="topbar-nav-left">
          <div className="topbar-tabs topbar-save-tabs">
            <details ref={menuRef} className="topbar-menu topbar-game-menu">
              <summary className={`topbar-tab topbar-game-tab ${gameKind === "developer" ? "has-kind" : ""}`}>
                <MdSave className="topbar-tab-icon" aria-hidden="true" focusable="false" />
                <span className="topbar-menu-summary-main">{gameName}</span>
                {gameKind === "developer" && <span className="topbar-menu-summary-kind">dev</span>}
              </summary>
              <button
                className="topbar-menu-backdrop"
                type="button"
                aria-label="Close save menu"
                onClick={closeMenu}
              />
              <div className="topbar-menu-panel">
                <header className="topbar-menu-current">
                  <div>
                    <span className="topbar-menu-kicker">Current Game</span>
                    <strong>{gameName}</strong>
                  </div>
                  <span className={`topbar-save-status ${saveStatus}`}>{storageLabel}</span>
                </header>

                <div className="topbar-menu-metrics mono">
                  <Stat label="Tick" value={tick.toLocaleString()} />
                  <Stat label="Fleet" value={`Ç${Math.round(fleet).toLocaleString()}`} />
                  <Stat label="Slots" value={saveSlots.length.toString()} />
                </div>

                <section className="topbar-menu-section">
                  <div className="topbar-menu-heading">
                    <span>Saved Games</span>
                    {activeSlot && <span className="topbar-menu-muted">active · {formatSlotTime(activeSlot.updatedAt)}</span>}
                  </div>
                  <div className="topbar-save-list">
                    {saveSlots.length === 0 ? (
                      <div className="topbar-menu-empty">Browser storage unavailable.</div>
                    ) : saveSlots.map(slot => (
                      <SaveSlotRow
                        key={slot.id}
                        slot={slot}
                        active={slot.id === activeSaveId}
                        canDelete={saveSlots.length > 1}
                        onLoad={() => {
                          loadGame(slot.id);
                          closeMenu();
                        }}
                        onDelete={() => deleteGame(slot.id)}
                      />
                    ))}
                  </div>
                  <div className="topbar-menu-actions">
                    <button
                      className="topbar-command primary"
                      onClick={() => {
                        saveCurrentGame();
                        closeMenu();
                      }}
                    >
                      <MdSave aria-hidden="true" focusable="false" />
                      <span>Save now</span>
                    </button>
                    <button
                      className="topbar-command"
                      onClick={() => {
                        createGame();
                        closeMenu();
                      }}
                    >
                      <MdAdd aria-hidden="true" focusable="false" />
                      <span>New game</span>
                    </button>
                  </div>
                </section>

                <section className="topbar-menu-section topbar-dev-section">
                  <div className="topbar-menu-heading">
                    <span>Developer</span>
                    <span className="topbar-menu-muted">local tools</span>
                  </div>
                  <div className="topbar-menu-actions">
                    <button
                      className="topbar-command"
                      onClick={() => {
                        loadDeveloperState();
                        closeMenu();
                      }}
                    >
                      <MdCode aria-hidden="true" focusable="false" />
                      <span>Load dev state</span>
                    </button>
                    <button
                      className="topbar-command topbar-command-danger"
                      onClick={() => {
                        reset();
                        closeMenu();
                      }}
                    >
                      <MdRestartAlt aria-hidden="true" focusable="false" />
                      <span>Reset current</span>
                    </button>
                  </div>
                </section>
              </div>
            </details>
          </div>

          <nav className="topbar-tabs topbar-view-tabs" aria-label="Game views">
            {TABS.map(tab => (
              <button
                key={tab.id}
                className={`topbar-tab ${selectedTab === tab.id ? "active" : ""}`}
                onClick={() => selectTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="topbar-speed-tabs" aria-label="Game speed">
          <button className="topbar-tab" onClick={step} disabled={speed !== 0} title="Step one tick">Step</button>
          {SPEED_PRESETS.map((p) => (
            <button
              key={p.value}
              className={`topbar-tab ${speed === p.value ? "active" : ""}`}
              onClick={() => setSpeed(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="topbar-card">
        <label className="topbar-ship-picker">
          <span className="topbar-ship-select-wrap">
            <select
              className="topbar-ship-select"
              aria-label="Controlled ship"
              value={selectedShipId}
              onChange={(event) => selectTrader(event.currentTarget.value || null)}
              disabled={playerShips.length === 0}
            >
              {playerShips.length === 0 ? (
                <option value="">No ship</option>
              ) : playerShips.map(ship => (
                <option key={ship.id} value={ship.id}>{ship.name}</option>
              ))}
            </select>
          </span>
        </label>

        <div className="topbar-stats mono">
          <Stat label="Tick" value={tick.toLocaleString()} />
          {world.player && <Stat label="Fleet" value={`Ç${Math.round(fleet).toLocaleString()}`} />}
        </div>

        {selectedTab === "player" ? (
          <div className="topbar-pilot-tabs" aria-label="Pilot mode">
            <button
              className={`topbar-tab ${selectedShip?.pilot === "manual" ? "active" : ""}`}
              onClick={() => selectedShip && setPilot(selectedShip.id, "manual")}
              disabled={!selectedShip}
            >
              <GiShipWheel className="topbar-tab-icon" aria-hidden="true" focusable="false" />
              Manual
            </button>
            <button
              className={`topbar-tab ${selectedShip?.pilot === "auto" ? "active" : ""}`}
              onClick={() => selectedShip && setPilot(selectedShip.id, "auto")}
              disabled={!selectedShip || autoBlocked}
              title={autoBlocked ? "Hire a pilot to enable auto-play" : "Auto-play: pilot handles trading. Navigator unlocks guided hints."}
            >
              <GiRadarSweep className="topbar-tab-icon" aria-hidden="true" focusable="false" />
              Auto
            </button>
          </div>
        ) : pageSummary && (
          <div className="topbar-page-summary" aria-label={`${selectedTab} summary`}>
            {pageSummary.map(item => (
              <TopbarSummaryItem key={item.label} {...item} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function SaveSlotRow({ slot, active, canDelete, onLoad, onDelete }: {
  slot: SaveSlotSummary;
  active: boolean;
  canDelete: boolean;
  onLoad: () => void;
  onDelete: () => void;
}) {
  return (
    <div className={`topbar-save-row ${active ? "active" : ""}`}>
      <button className="topbar-save-main" onClick={onLoad} disabled={active}>
        <span className="topbar-save-name">{slot.name}</span>
        <span className="topbar-save-meta">
          <span>{slot.kind === "developer" ? "developer" : "standard"}</span>
          <span className="mono">t{slot.tick.toLocaleString()}</span>
          <span>{formatSlotTime(slot.updatedAt)}</span>
        </span>
      </button>
      <button
        className="topbar-save-delete"
        onClick={onDelete}
        disabled={!canDelete}
        title={canDelete ? `Delete ${slot.name}` : "Keep at least one save"}
        aria-label={`Delete ${slot.name}`}
      >
        <MdClose aria-hidden="true" focusable="false" />
      </button>
    </div>
  );
}

function formatSlotTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timestamp));
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="topbar-stat">
      <span className="topbar-stat-label dim">{label}</span>
      <span className="topbar-stat-value">{value}</span>
    </span>
  );
}

interface TopbarSummary {
  icon: IconType;
  label: string;
  value: ReactNode;
}

function TopbarSummaryItem({ icon: Icon, label, value }: TopbarSummary) {
  return (
    <span className="topbar-summary-item">
      <Icon className="topbar-summary-icon" aria-hidden="true" focusable="false" />
      <span>
        <span className="topbar-summary-label">{label}</span>
        <span className="topbar-summary-value">{value}</span>
      </span>
    </span>
  );
}

function buildPageSummary(tab: Tab, world: World, cash: number): TopbarSummary[] | null {
  if (tab === "markets") {
    const stats = commoditySummaryStats(world);
    return [
      { icon: GiCargoCrate, label: "Commodities", value: stats.commodities.toLocaleString() },
      { icon: GiFactory, label: "Markets", value: stats.markets.toLocaleString() },
      { icon: GiTrade, label: "Quotes", value: stats.quotes.toLocaleString() },
      { icon: GiReceiveMoney, label: "Short", value: stats.short.toLocaleString() },
      { icon: GiUpgrade, label: "Upgrades", value: stats.upgrades.toLocaleString() },
    ];
  }

  if (tab === "locations") {
    return [
      { icon: GiHabitatDome, label: "Stations", value: Object.keys(world.locations).length.toLocaleString() },
      { icon: GiRadarSweep, label: "Ships", value: Object.keys(world.traders).length.toLocaleString() },
      { icon: GiPathDistance, label: "Routes", value: routeCount(world).toLocaleString() },
      { icon: GiContract, label: "Contracts", value: Object.values(world.jobs).filter(j => j.acceptedBy == null).length.toLocaleString() },
      { icon: GiTrade, label: "Age", value: `t${world.tick.toLocaleString()}` },
    ];
  }

  if (tab === "stocks") {
    const unrealized = totalUnrealizedPnl(world);
    const positions = listPositions(world);
    const longCount = positions.filter(p => p.kind === "long").length;
    const shortCount = positions.filter(p => p.kind === "short").length;
    return [
      { icon: GiWallet, label: "Cash", value: `Ç${Math.round(cash).toLocaleString()}` },
      { icon: GiBank, label: "Long MV", value: `Ç${Math.round(portfolioValue(world)).toLocaleString()}` },
      {
        icon: GiTrade,
        label: "Unrealized",
        value: (
          <span className={unrealized > 0 ? "stock-pnl-up" : unrealized < 0 ? "stock-pnl-down" : ""}>
            {unrealized >= 0 ? "+" : ""}Ç{Math.round(unrealized).toLocaleString()}
          </span>
        ),
      },
      { icon: GiCargoCrate, label: "Positions", value: `${longCount}L · ${shortCount}S` },
    ];
  }

  return null;
}

function commoditySummaryStats(world: World) {
  let quotes = 0;
  let short = 0;
  let upgrades = 0;
  const goods = Object.values(world.goods);
  for (const good of goods) {
    let totalStock = 0;
    let totalTarget = 0;
    let activeMarkets = 0;
    for (const loc of Object.values(world.locations)) {
      const market = world.markets[loc.id];
      const stock = market?.stock[good.id] ?? 0;
      const target = loc.targetStock[good.id] ?? 0;
      if (stock > 0.001 || target > 0) activeMarkets += 1;
      totalStock += stock;
      totalTarget += target;
    }
    quotes += activeMarkets;
    if (totalTarget > 0 && totalStock / totalTarget < 0.55) short += 1;
    if (good.category === "upgrade") upgrades += 1;
  }
  return {
    commodities: goods.length,
    markets: Object.keys(world.locations).length,
    quotes,
    short,
    upgrades,
  };
}
