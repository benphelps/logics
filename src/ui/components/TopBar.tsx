import { useRef } from "react";
import { MdAdd, MdClose, MdCode, MdRestartAlt, MdSave } from "react-icons/md";
import { useStore, type Speed } from "../store";
import type { SaveSlotSummary } from "../saveGames";
import "./TopBar.css";

const SPEED_PRESETS: { value: Speed; label: string }[] = [
  { value: 0,  label: "Pause" },
  { value: 1,  label: "1×" },
  { value: 4,  label: "4×" },
  { value: 16, label: "16×" },
];

export function TopBar() {
  const menuRef = useRef<HTMLDetailsElement>(null);
  const speed = useStore((s) => s.speed);
  const setSpeed = useStore((s) => s.setSpeed);
  const step = useStore((s) => s.step);
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
  const fleet = world.player
    ? world.player.shipIds.reduce((s, id) => s + (world.traders[id]?.funds ?? 0), 0)
    : 0;
  const storageLabel = saveStatus === "saved" ? "Autosaved" : saveStatus === "unavailable" ? "Unsaved" : "Save error";
  const closeMenu = () => {
    if (menuRef.current) menuRef.current.open = false;
  };

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-title">Logics</span>
        <span className="topbar-subtitle dim">spreadsheet trading sim</span>
      </div>

      <div className="topbar-stats mono">
        <Stat label="Tick" value={tick.toLocaleString()} />
        {world.player && <Stat label="Fleet" value={`Ç${Math.round(fleet).toLocaleString()}`} />}
      </div>

      <div className="topbar-controls">
        <div className="topbar-speed-group">
          <button onClick={step} disabled={speed !== 0} title="Step one tick">Step</button>
          {SPEED_PRESETS.map((p) => (
            <button
              key={p.value}
              className={speed === p.value ? "primary" : ""}
              onClick={() => setSpeed(p.value)}
            >
              {p.label}
            </button>
          ))}
        </div>
        <span className="topbar-spacer" />
        <details ref={menuRef} className="topbar-menu">
          <summary className={gameKind === "developer" ? "has-kind" : ""}>
            <span className="topbar-menu-summary-main">{gameName}</span>
            {gameKind === "developer" && <span className="topbar-menu-summary-kind">dev</span>}
          </summary>
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
    </header>
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
