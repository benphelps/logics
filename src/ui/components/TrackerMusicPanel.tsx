import type { CSSProperties } from "react";
import { MdGraphicEq, MdPause, MdPlayArrow, MdRefresh, MdVolumeUp } from "react-icons/md";
import { TRACKER_MODES } from "../music/keygenTracker";
import type { KeygenMusicControls } from "../music/useKeygenMusic";
import "./TrackerMusicPanel.css";

export function TrackerMusicPanel({ music }: { music: KeygenMusicControls }) {
  const { snapshot } = music;
  const activeStep = snapshot.row;
  const visibleRows = rowsAround(snapshot.pattern, activeStep, 14);
  const progress = snapshot.duration > 0 ? Math.min(1, Math.max(0, snapshot.position / snapshot.duration)) : 0;
  const panelStyle = {
    "--tracker-channel-count": snapshot.channelLabels.length,
    "--tracker-table-width": `${74 + snapshot.channelLabels.length * 96}px`,
  } as CSSProperties;
  const progressStyle = { transform: `scaleX(${progress})` };
  const footnote = snapshot.mode.credit
    ? `${snapshot.mode.credit}. Reference only; replace before commercial shipping.`
    : "libopenmpt playback of tracker files with all source channels shown in the tracker table.";

  return (
    <section className="tracker-panel" aria-label="Module music tracker" style={panelStyle}>
      <div className="tracker-player">
        <button
          className={`tracker-transport ${snapshot.playing ? "playing" : ""}`}
          type="button"
          onClick={music.toggle}
          disabled={snapshot.loading}
          aria-label={snapshot.playing ? "Pause music" : "Play music"}
          title={snapshot.playing ? "Pause" : "Play"}
        >
          {snapshot.playing ? <MdPause aria-hidden="true" /> : <MdPlayArrow aria-hidden="true" />}
        </button>

        <div className="tracker-player-main">
          <div className="tracker-track-line">
            <label className="tracker-program-select">
              <select
                aria-label="Music program"
                value={snapshot.mode.id}
                onChange={(event) => music.setMode(event.target.value as typeof snapshot.mode.id)}
              >
                {TRACKER_MODES.map(mode => (
                  <option value={mode.id} key={mode.id}>{mode.label}</option>
                ))}
              </select>
            </label>
            <button
              className="tracker-icon-button"
              type="button"
              onClick={music.regenerate}
              disabled={snapshot.loading}
              aria-label="Restart music"
              title="Restart"
            >
              <MdRefresh aria-hidden="true" />
            </button>
          </div>

          <div className="tracker-progress-line mono">
            <span>{formatTime(snapshot.position)}</span>
            <span className="tracker-progress-bar" aria-hidden="true">
              <i style={progressStyle} />
            </span>
            <span>{formatTime(snapshot.duration)}</span>
          </div>
        </div>

        <label className="tracker-player-volume">
          <MdVolumeUp aria-hidden="true" />
          <input
            aria-label="Music volume"
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={snapshot.volume}
            onChange={(event) => music.setVolume(Number(event.target.value))}
          />
        </label>
      </div>

      {snapshot.error && <div className="tracker-error">{snapshot.error}</div>}

      <div className="tracker-table-wrap">
        <table className="tracker-table mono">
          <colgroup>
            <col className="tracker-row-col" />
            {snapshot.channelLabels.map((label, index) => <col className="tracker-channel-col" key={`${label}-${index}`} />)}
          </colgroup>
          <thead>
            <tr>
              <th>Row</th>
              {snapshot.channelLabels.map((label, index) => (
                <th className="tracker-channel-heading" key={`${label}-${index}`}>
                  <span className="tracker-header-vu" aria-hidden="true">
                    <i style={{ transform: `scaleX(${Math.max(0.06, snapshot.levels[index] ?? 0)})` }} />
                  </span>
                  <span className="tracker-channel-label">{label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map(row => {
              const active = row.step === activeStep;
              return (
                <tr key={`${row.step}-${active ? "active" : "idle"}`} className={active ? "active" : ""}>
                  <td>{row.section}:{formatRowStep(row.step, snapshot.pattern.length)}</td>
                  {snapshot.channelLabels.map((label, index) => (
                    <td key={`${label}-${index}`} className={row.channels[index] ? `has-event channel-${index % 8}` : ""}>
                      {row.channels[index]?.label ?? "..."}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="tracker-footer">
        <div className="tracker-footnote">
          <MdGraphicEq aria-hidden="true" />
          <span>{footnote}</span>
        </div>
        <div className="tracker-meta mono">
          <span>{snapshot.mode.format}</span>
          <span>{snapshot.channelLabels.length} CH</span>
          <span>{snapshot.mode.bpm} BPM</span>
          <span>{formatTime(snapshot.position)} / {formatTime(snapshot.duration)}</span>
          <span>ORD {snapshot.order.toString(16).toUpperCase().padStart(2, "0")}</span>
          <span>PAT {snapshot.patternIndex.toString(16).toUpperCase().padStart(2, "0")}</span>
          <span>{snapshot.pattern[activeStep]?.section ?? "..."}</span>
        </div>
      </div>
    </section>
  );
}

function formatRowStep(step: number, rowCount: number): string {
  return step.toString(16).toUpperCase().padStart(rowCount > 0xff ? 3 : 2, "0");
}

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds.toString().padStart(2, "0")}`;
}

function rowsAround<T extends { step: number }>(rows: T[], activeStep: number, count: number): T[] {
  const start = activeStep - Math.floor(count / 2);
  const out: T[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(rows[((start + i) % rows.length + rows.length) % rows.length]);
  }
  return out;
}
