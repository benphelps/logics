import { useStore, type Speed } from "../store";
import "./TopBar.css";

const SPEED_PRESETS: { value: Speed; label: string }[] = [
  { value: 0,  label: "Pause" },
  { value: 1,  label: "1×" },
  { value: 4,  label: "4×" },
  { value: 16, label: "16×" },
];

export function TopBar() {
  const speed = useStore((s) => s.speed);
  const setSpeed = useStore((s) => s.setSpeed);
  const step = useStore((s) => s.step);
  const reset = useStore((s) => s.reset);
  const world = useStore((s) => s.world);
  useStore((s) => s.tickEpoch);

  const tick = world.tick;
  const traders = Object.values(world.traders);
  const totalFunds = traders.reduce((sum, t) => sum + t.funds, 0);

  return (
    <header className="topbar">
      <div className="topbar-brand">
        <span className="topbar-title">Logics</span>
        <span className="topbar-subtitle dim">spreadsheet trading sim</span>
      </div>

      <div className="topbar-stats mono">
        <Stat label="Tick"    value={tick.toLocaleString()} />
        <Stat label="Ships"   value={traders.length.toString()} />
        <Stat label="Fleet"   value={`Ç${Math.round(totalFunds).toLocaleString()}`} />
        {world.player && (
          <Stat label="Bank"  value={`Ç${Math.round(world.player.funds).toLocaleString()}`} />
        )}
      </div>

      <div className="topbar-controls">
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
        <span className="topbar-spacer" />
        <button onClick={reset} title="Restart from tick 0">Reset</button>
      </div>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="topbar-stat">
      <span className="topbar-stat-label dim">{label}</span>
      <span className="topbar-stat-value">{value}</span>
    </span>
  );
}
