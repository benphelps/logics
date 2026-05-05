import { useRef, useState } from "react";
import { MdAdd, MdClose, MdCode, MdMenu, MdMonetizationOn, MdMusicNote, MdRestartAlt, MdSave, MdSkipNext } from "react-icons/md";
import { useStore, type Speed, type Tab } from "../store";
import { useIsMobile } from "../useIsMobile";
import { useCrewHeadshot } from "../headshots";
import { DEV_MODE } from "../devMode";
import { MOBILE_PANELS, defaultMobilePanelId } from "../mobilePanels";
import { cargoMass } from "../../sim/cargo";
import type { Trader, World } from "../../sim/types";
import type { SaveSlotSummary } from "../saveGames";
import { MobilePanelTabs } from "./MobilePanelTabs";
import { Modal } from "./Modal";
import { TrackerMusicPanel } from "./TrackerMusicPanel";
import { useKeygenMusic } from "../music/useKeygenMusic";
import "./TopBar.css";

const SPEED_PRESETS: { value: Speed; label: string }[] = [
  { value: 0,  label: "Pause" },
  { value: 1,  label: "1×" },
  { value: 4,  label: "4×" },
  { value: 16, label: "16×" },
];

const TABS: { id: Tab; label: string }[] = [
  { id: "player", label: "Cargo" },
  { id: "stocks", label: "Exchange" },
  { id: "markets", label: "Markets" },
  { id: "locations", label: "Atlas" },
  { id: "charters", label: "Ledger" },
];

export function TopBar() {
  const shipMenuRef = useRef<HTMLDetailsElement>(null);
  const [saveModalOpen, setSaveModalOpen] = useState(false);
  const [musicModalOpen, setMusicModalOpen] = useState(false);
  const music = useKeygenMusic();
  const selectedTab = useStore((s) => s.selectedTab);
  const selectTab = useStore((s) => s.selectTab);
  const isMobile = useIsMobile();
  const mobilePanel = useStore((s) => s.mobilePanel);
  const setMobilePanel = useStore((s) => s.setMobilePanel);
  const mobilePanels = MOBILE_PANELS[selectedTab];
  const activeMobilePanel = mobilePanel[selectedTab] ?? defaultMobilePanelId(selectedTab) ?? "";
  const selectedTrader = useStore((s) => s.selectedTrader);
  const selectTrader = useStore((s) => s.selectTrader);
  const speed = useStore((s) => s.speed);
  const setSpeed = useStore((s) => s.setSpeed);
  const step = useStore((s) => s.step);
  const reset = useStore((s) => s.reset);
  const saveCurrentGame = useStore((s) => s.saveCurrentGame);
  const createGame = useStore((s) => s.createGame);
  const loadGame = useStore((s) => s.loadGame);
  const deleteGame = useStore((s) => s.deleteGame);
  const loadDeveloperState = useStore((s) => s.loadDeveloperState);
  const giveCredits = useStore((s) => s.giveCredits);
  const activeSaveId = useStore((s) => s.activeSaveId);
  const saveSlots = useStore((s) => s.saveSlots);
  const saveError = useStore((s) => s.saveError);
  const world = useStore((s) => s.world);
  useStore((s) => s.tickEpoch);

  const tick = world.tick;
  const playerShipIds = world.player?.shipIds ?? [];
  const playerShips = playerShipIds.map(id => world.traders[id]).filter(Boolean);
  const selectedShip = selectedTrader && playerShipIds.includes(selectedTrader)
    ? world.traders[selectedTrader] ?? playerShips[0] ?? null
    : playerShips[0] ?? null;
  const selectedShipId = selectedShip?.id ?? "";
  const closeShipMenu = () => {
    if (shipMenuRef.current) shipMenuRef.current.open = false;
  };
  const openSaveModal = () => setSaveModalOpen(true);
  const closeSaveModal = () => setSaveModalOpen(false);
  const openMusicModal = () => setMusicModalOpen(true);
  const closeMusicModal = () => setMusicModalOpen(false);

  return (
    <section className={`topbar-shell ${isMobile ? "topbar-mobile" : ""}`} aria-label="Game controls">
      <div className="topbar-nav-row">
        <div className="topbar-tabs topbar-ship-tabs">
          <details ref={shipMenuRef} className={`topbar-menu topbar-ship-picker ${playerShips.length === 0 ? "is-empty" : ""}`}>
            <summary className="topbar-tab topbar-ship-tab" aria-label="Controlled ship">
              <span className="topbar-ship-summary-main">
                <span className="topbar-ship-name">{selectedShip?.name ?? "No ship"}</span>
                {selectedShip && (
                  <span className={`topbar-ship-state state-${selectedShip.state}`}>
                    {shipStateLabel(selectedShip)}
                  </span>
                )}
              </span>
            </summary>
            <button
              className="topbar-menu-backdrop"
              type="button"
              aria-label="Close ship menu"
              onClick={closeShipMenu}
            />
            <div className="topbar-ship-menu">
              {playerShips.length === 0 ? (
                <div className="topbar-ship-empty">No controlled ships available.</div>
              ) : playerShips.map(ship => {
                const active = ship.id === selectedShipId;
                return (
                  <button
                    key={ship.id}
                    className={`topbar-ship-option ${active ? "active" : ""}`}
                    onClick={() => {
                      selectTrader(ship.id);
                      closeShipMenu();
                    }}
                    type="button"
                  >
                    <span className="topbar-ship-option-head">
                      <span className="topbar-ship-option-name">{ship.name}</span>
                      <span className={`topbar-ship-state state-${ship.state}`}>{shipStateLabel(ship)}</span>
                    </span>
                    <span className="topbar-ship-option-meta">
                      <span><span>Wallet</span>{formatCredits(ship.funds)}</span>
                      <span><span>Cargo</span>{cargoMass(ship, world).toFixed(0)}/{ship.capacity}</span>
                      <span>{shipLocationLabel(ship, world)}</span>
                      <span>{ship.pilot}</span>
                    </span>
                  </button>
                );
              })}
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

        <div className="topbar-run-controls">
          <span className="topbar-tick-pill mono" aria-label={`Tick ${tick.toLocaleString()}`}>
            <span>Tick</span>
            <strong>{tick.toLocaleString()}</strong>
          </span>
          <div className="topbar-speed-tabs" aria-label="Game speed">
            <button className="topbar-tab topbar-step-button" onClick={step} disabled={speed !== 0} title="Step one tick" aria-label="Step one tick">
              <MdSkipNext className="topbar-tab-icon" aria-hidden="true" focusable="false" />
            </button>
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
          <button
            className={`topbar-tab topbar-menu-button topbar-music-button ${musicModalOpen || music.snapshot.playing ? "active" : ""}`}
            onClick={openMusicModal}
            aria-label="Open music tracker"
            title="Music tracker"
          >
            <MdMusicNote className="topbar-tab-icon" aria-hidden="true" focusable="false" />
          </button>
          <button
            className="topbar-tab topbar-menu-button"
            onClick={openSaveModal}
            aria-label="Open save menu"
            title="Save games"
          >
            <MdMenu className="topbar-tab-icon" aria-hidden="true" focusable="false" />
          </button>
        </div>

        {isMobile && mobilePanels && mobilePanels.length > 0 && (
          <MobilePanelTabs
            panels={mobilePanels}
            active={activeMobilePanel}
            onChange={(id) => setMobilePanel(selectedTab, id)}
          />
        )}
      </div>

      <Modal
        open={saveModalOpen}
        onClose={closeSaveModal}
        eyebrow="Saved games"
        title="Continue your run"
        dialogClassName="topbar-save-modal"
      >
        {saveError && (
          <div className="topbar-save-error-detail">
            {saveError}
          </div>
        )}

        <section className="topbar-menu-section">
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
                  closeSaveModal();
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
                closeSaveModal();
              }}
            >
              <MdSave aria-hidden="true" focusable="false" />
              <span>Save now</span>
            </button>
            <button
              className="topbar-command"
              onClick={() => {
                createGame();
                closeSaveModal();
              }}
            >
              <MdAdd aria-hidden="true" focusable="false" />
              <span>New game</span>
            </button>
          </div>
        </section>

        {DEV_MODE && (
          <section className="topbar-menu-section topbar-dev-section">
            <div className="topbar-menu-heading">
              <span>Developer</span>
              <span className="topbar-menu-muted">?dev=1 only</span>
            </div>
            <div className="topbar-menu-actions">
              <button
                className="topbar-command"
                onClick={() => {
                  loadDeveloperState();
                  closeSaveModal();
                }}
              >
                <MdCode aria-hidden="true" focusable="false" />
                <span>Load dev state</span>
              </button>
              <button
                className="topbar-command"
                onClick={() => {
                  giveCredits(1_000_000);
                  closeSaveModal();
                }}
                title="Add Ç1,000,000 to your flagship's wallet"
              >
                <MdMonetizationOn aria-hidden="true" focusable="false" />
                <span>Give Ç1M</span>
              </button>
              <button
                className="topbar-command topbar-command-danger"
                onClick={() => {
                  reset();
                  closeSaveModal();
                }}
              >
                <MdRestartAlt aria-hidden="true" focusable="false" />
                <span>Reset current</span>
              </button>
            </div>
          </section>
        )}
      </Modal>

      <Modal
        open={musicModalOpen}
        onClose={closeMusicModal}
        eyebrow="Module tracker"
        title="Music"
        dialogClassName="topbar-music-modal"
      >
        <TrackerMusicPanel music={music} />
      </Modal>
    </section>
  );
}

function formatCredits(value: number): string {
  return `Ç${Math.round(value).toLocaleString()}`;
}

function shipStateLabel(ship: Trader): string {
  return ship.state === "transit" ? "Transit" : "Docked";
}

function shipLocationLabel(ship: Trader, world: World): string {
  if (ship.state === "transit" && ship.destination) {
    return `to ${world.locations[ship.destination]?.name ?? ship.destination} · ${ship.ticksRemaining}t`;
  }
  return world.locations[ship.location]?.name ?? ship.location;
}

function SaveSlotRow({ slot, active, canDelete, onLoad, onDelete }: {
  slot: SaveSlotSummary;
  active: boolean;
  canDelete: boolean;
  onLoad: () => void;
  onDelete: () => void;
}) {
  // Pilots are persisted with portraitId baked from the wizard variant,
  // so the cache key here is identical to the one the wizard generated
  // under. saveId=null means all pilots share gameId 0 in the headshot
  // store — fine because portraitIds are random per pilot, no collision.
  const portraitSubject = slot.pilotPortraitId
    ? { id: slot.pilotPortraitId, role: "captain" as const }
    : null;
  const headshot = useCrewHeadshot(null, portraitSubject);
  const portraitUrl = headshot?.status === "ready" ? headshot.url : null;
  const loading = headshot?.status === "loading";
  const displayName = slot.pilotName ?? slot.name;
  const isDev = slot.kind === "developer";

  return (
    <div
      className={`topbar-save-card ${active ? "active" : ""} ${portraitUrl ? "has-portrait" : ""} ${loading ? "portrait-loading" : ""}`}
      style={portraitUrl ? { backgroundImage: `url(${portraitUrl})` } : undefined}
    >
      <button
        className="topbar-save-card-main"
        onClick={onLoad}
        disabled={active}
        aria-label={`Load ${displayName}`}
      >
        <span className="topbar-save-card-body">
          <span className="topbar-save-card-name">{displayName}</span>
          <span className="topbar-save-card-meta">
            {isDev && <span className="topbar-save-card-tag">developer</span>}
            {active && <span className="topbar-save-card-tag active">active</span>}
            <span className="mono">t{slot.tick.toLocaleString()}</span>
            <span>{formatSlotTime(slot.updatedAt)}</span>
          </span>
        </span>
      </button>
      <button
        className="topbar-save-card-delete"
        onClick={onDelete}
        disabled={!canDelete}
        title={canDelete ? `Delete ${displayName}` : "Keep at least one save"}
        aria-label={`Delete ${displayName}`}
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
