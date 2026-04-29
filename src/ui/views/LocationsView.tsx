import { useMemo, useRef, useState, type CSSProperties } from "react";
import { GiCargoCrate } from "react-icons/gi";
import { useStore } from "../store";
import { reachableNeighbors, routeDistance, routeSegments } from "../../sim/geometry";
import { netProductionRate } from "../../sim/locations";
import type { LocationDef, LocationId, Trader, TraderId, World } from "../../sim/types";
import { headerArtUrl, stationArtUrl } from "../art";
import "./LocationsView.css";

const MAP_W = 1000;
const MAP_H = 620;
const MAP_PAD = 48;

type StationKind = "hub" | "mining" | "agri" | "frontier" | "research" | "station";
type PressureTone = "short" | "surplus" | "";

interface ProjectedLocation {
  loc: LocationDef;
  x: number;
  y: number;
  r: number;
  kind: StationKind;
}

interface AtlasLink {
  a: LocationId;
  b: LocationId;
  dist: number;
}

interface ShipMarker {
  id: TraderId;
  trader: Trader;
  x: number;
  y: number;
  // For idle ships, the projected station; for transit ships the lane
  // they're on. Used to drive lane-traffic shading and tooltips.
  origin: LocationId;
  destination: LocationId | null;
  isPlayer: boolean;
  isTransit: boolean;
}

interface LaneTraffic {
  count: number;
  // Outbound + inbound ships per lane regardless of direction. The map
  // shades lanes by this so corridors with traffic stand out.
  ships: TraderId[];
}

interface MarketRow {
  good: string;
  name: string;
  stock: number;
  target: number;
  price: number;
  base: number;
  tone: PressureTone;
}

interface StationPressure {
  short: number;
  surplus: number;
  focusGood: string;
  tone: PressureTone;
  // Avg absolute price skew across pressure-flagged goods (price/base - 1
  // averaged over short+surplus rows). Empty when no pressure rows.
  avgSkew: number;
}

interface StationSheetRow {
  loc: LocationDef;
  kind: StationKind;
  counts: ReturnType<typeof stationCounts>;
  pressure: StationPressure;
}

export function LocationsView() {
  const world = useStore((s) => s.world);
  const selectedLocation = useStore((s) => s.selectedLocation);
  const selectLocation = useStore((s) => s.selectLocation);
  const selectedTrader = useStore((s) => s.selectedTrader);
  const selectTrader = useStore((s) => s.selectTrader);
  useStore((s) => s.tickEpoch);

  const [sheetTab, setSheetTab] = useState<"systems" | "ships">("systems");

  const locations = Object.values(world.locations);
  const playerShipIds = world.player?.shipIds ?? [];
  const playerShip = selectedTrader && playerShipIds.includes(selectedTrader)
    ? world.traders[selectedTrader] ?? playerShipIds.map(id => world.traders[id]).find(Boolean) ?? null
    : playerShipIds.map(id => world.traders[id]).find(Boolean) ?? null;
  const selectedId = selectedLocation && world.locations[selectedLocation]
    ? selectedLocation
    : playerShip?.location ?? locations[0]?.id ?? null;
  const selected = selectedId ? world.locations[selectedId] : null;
  const sheetRows = useMemo(() => buildSheetRows(world, locations), [world, locations]);
  const projected = useMemo(() => projectLocations(locations), [locations]);
  const projectedById = useMemo(() => new Map(projected.map(p => [p.loc.id, p])), [projected]);
  const links = useMemo(() => buildAtlasLinks(world, locations), [world, locations]);
  const ships = useMemo(() => buildShipMarkers(world, projectedById), [world, projectedById]);
  const laneTraffic = useMemo(() => buildLaneTraffic(world), [world]);
  const selectedMarket = selected ? marketRows(world, selected).slice(0, 9) : [];
  const selectedCounts = selected ? stationCounts(world, selected.id) : { docked: 0, inbound: 0, jobs: 0, routes: 0 };

  return (
    <section className="atlas-view">
      <div className="atlas-grid">
        <section className="atlas-detail-panel">
          {selected ? (
            <DetailPanel
              world={world}
              loc={selected}
              counts={selectedCounts}
              marketRowsTop={selectedMarket}
              stationKind={stationKind(selected)}
              ships={ships}
              selectedTraderId={selectedTrader}
              onSelectTrader={selectTrader}
            />
          ) : (
            <div className="atlas-detail-empty dim">Select a station from the map or list.</div>
          )}
        </section>

        <aside className="atlas-side">
          <section className="atlas-map-panel">
            <div className="atlas-panel-head compact art-panel-head" style={artCardStyle(headerArtUrl("sectorMap"))}>
              <div>
                <span className="atlas-panel-label">Sector Inset</span>
                <span className="dim">Plotted trade routes; click nodes or rows to inspect</span>
              </div>
            </div>
            <SectorMap
              world={world}
              projected={projected}
              projectedById={projectedById}
              links={links}
              ships={ships}
              laneTraffic={laneTraffic}
              selectedId={selected?.id ?? null}
              playerLocation={playerShip?.location ?? null}
              playerDestination={playerShip?.state === "transit" ? playerShip.destination : null}
              selectedTraderId={selectedTrader}
              onSelect={selectLocation}
              onSelectTrader={selectTrader}
            />
          </section>

          <section className="atlas-sheet-panel">
            <div className="atlas-sheet-tabs bridge-card-tabs">
              <button
                type="button"
                className={`bridge-tab ${sheetTab === "systems" ? "active" : ""}`}
                onClick={() => setSheetTab("systems")}
              >
                Systems <span className="atlas-tab-count">{sheetRows.length}</span>
              </button>
              <button
                type="button"
                className={`bridge-tab ${sheetTab === "ships" ? "active" : ""}`}
                onClick={() => setSheetTab("ships")}
              >
                Ships <span className="atlas-tab-count">{Object.values(world.traders).length}</span>
              </button>
            </div>

            <div className="atlas-table-scroll">
              {sheetTab === "systems" ? (
                <SystemsTable
                  rows={sheetRows}
                  selectedId={selected?.id ?? null}
                  onSelect={selectLocation}
                />
              ) : (
                <ShipsTable
                  world={world}
                  selectedTraderId={selectedTrader}
                  onSelectTrader={selectTrader}
                  onSelectLocation={selectLocation}
                />
              )}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function artCardStyle(url: string): CSSProperties {
  return { "--card-art": `url("${url}")` } as CSSProperties;
}

function SectorMap({
  world,
  projected,
  projectedById,
  links,
  ships,
  laneTraffic,
  selectedId,
  playerLocation,
  playerDestination,
  selectedTraderId,
  onSelect,
  onSelectTrader,
}: {
  world: World;
  projected: ProjectedLocation[];
  projectedById: Map<LocationId, ProjectedLocation>;
  links: AtlasLink[];
  ships: ShipMarker[];
  laneTraffic: Map<string, LaneTraffic>;
  selectedId: LocationId | null;
  playerLocation: LocationId | null;
  playerDestination: LocationId | null;
  selectedTraderId: TraderId | null;
  onSelect: (id: LocationId) => void;
  onSelectTrader: (id: TraderId | null) => void;
}) {
  // viewBox state drives pan/zoom — wheel zooms toward the cursor,
  // mouse drag pans, double-click resets.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [vbox, setVbox] = useState({ x: 0, y: 0, w: MAP_W, h: MAP_H });
  const dragRef = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<{
    label: string;
    sub: string;
    px: number;
    py: number;
  } | null>(null);

  const peakLaneTraffic = Math.max(1, ...Array.from(laneTraffic.values()).map(t => t.count));

  const applyZoom = (clientX: number, clientY: number, factor: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const cx = vbox.x + ((clientX - rect.left) / rect.width) * vbox.w;
    const cy = vbox.y + ((clientY - rect.top) / rect.height) * vbox.h;
    const newW = Math.max(MAP_W * 0.18, Math.min(MAP_W * 1.6, vbox.w / factor));
    const newH = (newW / MAP_W) * MAP_H;
    setVbox({
      x: cx - (cx - vbox.x) * (newW / vbox.w),
      y: cy - (cy - vbox.y) * (newH / vbox.h),
      w: newW,
      h: newH,
    });
  };

  const onWheel = (e: React.WheelEvent<SVGSVGElement>) => {
    if (e.deltaY === 0) return;
    applyZoom(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015));
  };

  const onMouseDown = (e: React.MouseEvent<SVGSVGElement>) => {
    // Only left-button drags pan; let other handlers (clicks on shapes)
    // capture their own events first.
    if (e.button !== 0) return;
    dragRef.current = { sx: e.clientX, sy: e.clientY, vx: vbox.x, vy: vbox.y, moved: false };
  };
  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const dx = ((e.clientX - drag.sx) / rect.width) * vbox.w;
    const dy = ((e.clientY - drag.sy) / rect.height) * vbox.h;
    if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
    setVbox({ x: drag.vx - dx, y: drag.vy - dy, w: vbox.w, h: vbox.h });
  };
  const releaseDrag = () => { dragRef.current = null; };
  const onDoubleClick = () => setVbox({ x: 0, y: 0, w: MAP_W, h: MAP_H });

  // Click handlers on shapes consult dragRef.current?.moved before
  // committing — so a 5px drag-and-release doesn't accidentally select.
  const wasDrag = () => dragRef.current?.moved === true;

  const showTip = (e: React.MouseEvent, label: string, sub: string) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    setHover({ label, sub, px: e.clientX - rect.left, py: e.clientY - rect.top });
  };
  const moveTip = (e: React.MouseEvent) => {
    if (!hover) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    setHover({ ...hover, px: e.clientX - rect.left, py: e.clientY - rect.top });
  };
  const hideTip = () => setHover(null);

  const playerOrigin = playerLocation ? projectedById.get(playerLocation) ?? null : null;
  const playerDest = playerDestination ? projectedById.get(playerDestination) ?? null : null;

  return (
    <div ref={wrapRef} className="atlas-map-wrap">
      <svg
        ref={svgRef}
        className="atlas-map"
        viewBox={`${vbox.x} ${vbox.y} ${vbox.w} ${vbox.h}`}
        role="img"
        aria-label="Station map"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={releaseDrag}
        onMouseLeave={() => { releaseDrag(); hideTip(); }}
        onDoubleClick={onDoubleClick}
      >
        <defs>
          <radialGradient id="atlasGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
            <stop offset="100%" stopColor="rgba(255,255,255,0)" />
          </radialGradient>
        </defs>
        <rect className="atlas-map-bg" x={-MAP_W} y={-MAP_H} width={MAP_W * 3} height={MAP_H * 3} />
        <g className="atlas-gridlines">
          {[0.25, 0.5, 0.75].map(v => (
            <g key={v}>
              <line x1={MAP_W * v} y1={0} x2={MAP_W * v} y2={MAP_H} />
              <line x1={0} y1={MAP_H * v} x2={MAP_W} y2={MAP_H * v} />
            </g>
          ))}
        </g>
        <g className="atlas-links">
          {links.map(link => {
            const a = projectedById.get(link.a);
            const b = projectedById.get(link.b);
            if (!a || !b) return null;
            const traffic = laneTraffic.get(laneKey(link.a, link.b));
            const intensity = traffic ? Math.min(1, 0.2 + (traffic.count / peakLaneTraffic) * 0.8) : 0.2;
            return (
              <line
                key={`${link.a}-${link.b}`}
                className={traffic && traffic.count > 0 ? "atlas-link traffic" : "atlas-link"}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                style={{ opacity: intensity }}
                onMouseEnter={(e) => showTip(e, `${a.loc.name} ↔ ${b.loc.name}`, traffic && traffic.count > 0 ? `${traffic.count} ship${traffic.count === 1 ? "" : "s"} in transit` : "no traffic")}
                onMouseMove={moveTip}
                onMouseLeave={hideTip}
              />
            );
          })}
        </g>
        {playerOrigin && playerDest && (
          <g className="atlas-player-route">
            <line x1={playerOrigin.x} y1={playerOrigin.y} x2={playerDest.x} y2={playerDest.y} />
          </g>
        )}
        <g className="atlas-nodes">
          {projected.map(p => (
            <g
              key={p.loc.id}
              className={`atlas-node atlas-node-${p.kind} ${selectedId === p.loc.id ? "selected" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => { if (!wasDrag()) onSelect(p.loc.id); }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(p.loc.id);
                }
              }}
              onMouseEnter={(e) => showTip(e, p.loc.name, `${kindLabel(p.kind)} · ${formatPopulation(p.loc.population)} pop`)}
              onMouseMove={moveTip}
              onMouseLeave={hideTip}
            >
              <circle className="atlas-node-glow" cx={p.x} cy={p.y} r={p.r * 3.4} />
              <circle className="atlas-node-core" cx={p.x} cy={p.y} r={p.r} />
              {selectedId === p.loc.id && <circle className="atlas-node-ring" cx={p.x} cy={p.y} r={p.r + 9} />}
            </g>
          ))}
        </g>
        <g className="atlas-ships">
          {ships.map(ship => {
            const isSelected = selectedTraderId === ship.id;
            return (
              <g
                key={ship.id}
                className={`atlas-ship ${ship.isTransit ? "transit" : "idle"} ${ship.isPlayer ? "player" : ""} ${isSelected ? "selected" : ""}`}
                onClick={(e) => {
                  if (wasDrag()) return;
                  e.stopPropagation();
                  onSelectTrader(ship.id);
                }}
                onMouseEnter={(e) => {
                  const dst = ship.destination ? world.locations[ship.destination]?.name ?? "—" : null;
                  const sub = ship.isTransit
                    ? `transit → ${dst} · ETA ${ship.trader.ticksRemaining}t`
                    : `docked at ${world.locations[ship.origin]?.name ?? "—"}`;
                  showTip(e, ship.trader.name, sub);
                }}
                onMouseMove={moveTip}
                onMouseLeave={hideTip}
              >
                {ship.isPlayer ? (
                  <path
                    className="atlas-player-marker"
                    d={`M ${ship.x} ${ship.y - 9} L ${ship.x + 9} ${ship.y} L ${ship.x} ${ship.y + 9} L ${ship.x - 9} ${ship.y} Z`}
                  />
                ) : (
                  <circle cx={ship.x} cy={ship.y} r={ship.isTransit ? 3.4 : 2.6} />
                )}
                {isSelected && <circle className="atlas-ship-ring" cx={ship.x} cy={ship.y} r={11} />}
              </g>
            );
          })}
        </g>
      </svg>
      {hover && (
        <div className="atlas-tooltip" style={{ transform: `translate(${hover.px + 12}px, ${hover.py + 12}px)` }}>
          <div className="atlas-tooltip-title">{hover.label}</div>
          <div className="atlas-tooltip-sub dim">{hover.sub}</div>
        </div>
      )}
    </div>
  );
}

// Stable key for an unordered lane between two locations.
function laneKey(a: LocationId, b: LocationId): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Build a marker per ship — idle ships sit on their station, transit
// ships are interpolated along the lane from origin to destination using
// `(1 - ticksRemaining/totalTicks)`. Total trip ticks are recomputed
// from `routeDistance` and `speed` (the same formula traders.ts uses).
function buildShipMarkers(
  world: World,
  projectedById: Map<LocationId, ProjectedLocation>,
): ShipMarker[] {
  const playerIds = new Set(world.player?.shipIds ?? []);
  const out: ShipMarker[] = [];
  // Cluster idle ships at the station: stack them in a small spiral so
  // multiple traders parked at the same dock don't render on top of one
  // another. The order is stable per station via the trader id sort.
  const idleByStation = new Map<LocationId, Trader[]>();
  for (const t of Object.values(world.traders)) {
    if (t.state !== "idle") continue;
    const list = idleByStation.get(t.location) ?? [];
    list.push(t);
    idleByStation.set(t.location, list);
  }
  for (const [, list] of idleByStation) list.sort((a, b) => a.id.localeCompare(b.id));

  for (const t of Object.values(world.traders)) {
    if (t.state === "transit" && t.destination) {
      const a = projectedById.get(t.location);
      const b = projectedById.get(t.destination);
      if (!a || !b) continue;
      const dist = routeDistance(world, t.location, t.destination);
      const total = dist != null && t.speed > 0 ? Math.max(1, Math.ceil(dist / t.speed)) : Math.max(1, t.ticksRemaining);
      const progress = Math.max(0, Math.min(1, 1 - t.ticksRemaining / total));
      out.push({
        id: t.id,
        trader: t,
        x: a.x + (b.x - a.x) * progress,
        y: a.y + (b.y - a.y) * progress,
        origin: t.location,
        destination: t.destination,
        isPlayer: playerIds.has(t.id),
        isTransit: true,
      });
      continue;
    }
    const station = projectedById.get(t.location);
    if (!station) continue;
    const list = idleByStation.get(t.location) ?? [];
    const idx = list.indexOf(t);
    // Spiral offsets so 0..N idle ships visibly fan around the dock.
    const angle = idx * 0.8;
    const radius = idx === 0 ? 0 : station.r * 1.6 + (idx - 1) * 4;
    out.push({
      id: t.id,
      trader: t,
      x: station.x + Math.cos(angle) * radius,
      y: station.y + Math.sin(angle) * radius,
      origin: t.location,
      destination: null,
      isPlayer: playerIds.has(t.id),
      isTransit: false,
    });
  }
  return out;
}

// Per-lane traffic map: count + ids of all ships in transit between the
// two endpoints (direction-agnostic, keyed by sorted-id lane key).
function buildLaneTraffic(world: World): Map<string, LaneTraffic> {
  const map = new Map<string, LaneTraffic>();
  for (const t of Object.values(world.traders)) {
    if (t.state !== "transit" || !t.destination) continue;
    const key = laneKey(t.location, t.destination);
    const cur = map.get(key) ?? { count: 0, ships: [] };
    cur.count += 1;
    cur.ships.push(t.id);
    map.set(key, cur);
  }
  return map;
}

// Detail panel for the focused station — uses the same fleet-card
// patterns as the stock info column: art-backed panel head, KPI grid,
// trade-helper-section blocks separated by tight section titles.
// Systems sheet — trimmed columns focused on actionable trade signals.
// Drops the old Profile (tech/pop) and Goods stack (which clutter the
// row without driving decisions) and merges the four-cell pressure
// breakout into a single Pressure column with short/surplus counts +
// average price skew.
function SystemsTable(props: {
  rows: StationSheetRow[];
  selectedId: LocationId | null;
  onSelect: (id: LocationId) => void;
}) {
  return (
    <table className="atlas-sheet-table">
      <colgroup>
        <col className="col-station" />
        <col className="col-kind" />
        <col className="col-activity" />
        <col className="col-jobs" />
        <col className="col-pressure" />
        <col className="col-focus" />
      </colgroup>
      <thead>
        <tr>
          <th>Station</th>
          <th>Class</th>
          <th className="numeric">Ships</th>
          <th className="numeric">Jobs</th>
          <th>Pressure</th>
          <th>Focus</th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map(row => {
          const selectedRow = props.selectedId === row.loc.id;
          const totalShips = row.counts.docked + row.counts.inbound;
          return (
            <tr
              key={row.loc.id}
              className={selectedRow ? "active" : ""}
              onClick={() => props.onSelect(row.loc.id)}
            >
              <td>
                <span className="atlas-station-cell">
                  <span className={`atlas-kind-dot atlas-kind-${row.kind}`} />
                  <span>
                    <span className="atlas-station-name">{row.loc.name}</span>
                    <span className="atlas-station-sub dim">{row.loc.traits.faction ?? "Independent"}</span>
                  </span>
                </span>
              </td>
              <td><span className={`atlas-kind atlas-kind-${row.kind}`}>{kindLabel(row.kind)}</span></td>
              <td className="numeric mono">
                <span className={totalShips > 0 ? "" : "dim"}>{totalShips}</span>
                <span className="atlas-cell-sub dim">{row.counts.docked}d + {row.counts.inbound}i</span>
              </td>
              <td className="numeric mono">
                <span className={row.counts.jobs > 0 ? "" : "dim"}>{row.counts.jobs}</span>
              </td>
              <td>
                <span className="atlas-pressure-cell">
                  {row.pressure.short > 0 && <span className="bad">{row.pressure.short}↓</span>}
                  {row.pressure.surplus > 0 && <span className="good">{row.pressure.surplus}↑</span>}
                  {row.pressure.avgSkew > 0 && (
                    <span className={row.pressure.tone === "short" ? "bad" : row.pressure.tone === "surplus" ? "good" : "dim"}>
                      {(row.pressure.avgSkew * 100).toFixed(0)}%
                    </span>
                  )}
                  {row.pressure.short === 0 && row.pressure.surplus === 0 && (
                    <span className="dim">balanced</span>
                  )}
                </span>
              </td>
              <td>
                <span className={`atlas-focus ${row.pressure.tone}`}>{row.pressure.focusGood}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

// Ships sheet — every trader in the world, focused on actionable
// fields: name, status (docked vs in-transit with origin → dest), ETA
// for transit, cargo fill ratio, pilot mode. Click a row to pin the
// trader (and jump to its current/destination station).
function ShipsTable(props: {
  world: World;
  selectedTraderId: TraderId | null;
  onSelectTrader: (id: TraderId | null) => void;
  onSelectLocation: (id: LocationId) => void;
}) {
  const playerIds = new Set(props.world.player?.shipIds ?? []);
  const ships = Object.values(props.world.traders).slice().sort((a, b) => {
    // Player ships first, then transit (visible motion), then by name.
    const ap = playerIds.has(a.id) ? 0 : 1;
    const bp = playerIds.has(b.id) ? 0 : 1;
    if (ap !== bp) return ap - bp;
    if (a.state !== b.state) return a.state === "transit" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return (
    <table className="atlas-sheet-table">
      <colgroup>
        <col className="col-ship" />
        <col className="col-state" />
        <col className="col-route" />
        <col className="col-eta" />
        <col className="col-cargo" />
        <col className="col-pilot" />
      </colgroup>
      <thead>
        <tr>
          <th>Ship</th>
          <th>State</th>
          <th>Where</th>
          <th className="numeric">ETA</th>
          <th className="numeric">Cargo</th>
          <th>Pilot</th>
        </tr>
      </thead>
      <tbody>
        {ships.map(t => {
          const isSelected = props.selectedTraderId === t.id;
          const isPlayer = playerIds.has(t.id);
          const cargoQty = t.cargo.reduce((s, l) => s + l.qty, 0);
          const cargoPct = t.capacity > 0 ? (cargoQty / t.capacity) * 100 : 0;
          const cur = props.world.locations[t.location]?.name ?? "—";
          const dst = t.destination ? props.world.locations[t.destination]?.name ?? "—" : null;
          return (
            <tr
              key={t.id}
              className={`${isSelected ? "active" : ""} ${isPlayer ? "player" : ""} ${t.state}`}
              onClick={() => {
                props.onSelectTrader(t.id);
                if (t.state === "idle") props.onSelectLocation(t.location);
                else if (t.destination) props.onSelectLocation(t.destination);
              }}
            >
              <td>
                <span className="atlas-ship-cell">
                  {isPlayer && <span className="atlas-ship-pill player">YOU</span>}
                  <span className="atlas-ship-name">{t.name}</span>
                </span>
              </td>
              <td>
                <span className={`atlas-state-pill ${t.state}`}>
                  {t.state === "transit" ? "TRANSIT" : "DOCKED"}
                </span>
              </td>
              <td className="atlas-route-cell">
                {t.state === "transit" && dst ? (
                  <span className="atlas-route">
                    <span className="dim">{cur}</span>
                    <span className="atlas-route-arrow">→</span>
                    <span>{dst}</span>
                  </span>
                ) : (
                  <span className="mono">{cur}</span>
                )}
              </td>
              <td className="numeric mono">
                {t.state === "transit" ? `${t.ticksRemaining}t` : <span className="dim">—</span>}
              </td>
              <td className="numeric mono">
                <CargoBar pct={cargoPct} qty={cargoQty} cap={t.capacity} />
              </td>
              <td>
                <span className={`atlas-pilot-pill pilot-${t.pilot}`}>{t.pilot}</span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function CargoBar({ pct, qty, cap }: { pct: number; qty: number; cap: number }) {
  return (
    <span className="atlas-cargo-cell" title={`${qty.toFixed(0)} / ${cap}`}>
      <span className="atlas-cargo-track">
        <span className="atlas-cargo-fill" style={{ width: `${Math.min(100, pct)}%` }} />
      </span>
      <span>{pct.toFixed(0)}%</span>
    </span>
  );
}

function DetailPanel(props: {
  world: World;
  loc: LocationDef;
  counts: ReturnType<typeof stationCounts>;
  marketRowsTop: MarketRow[];
  stationKind: StationKind;
  ships: ShipMarker[];
  selectedTraderId: TraderId | null;
  onSelectTrader: (id: TraderId | null) => void;
}) {
  const { world, loc, counts, marketRowsTop, stationKind: kind, ships, selectedTraderId, onSelectTrader } = props;
  const artUrl = stationArtUrl(loc);

  // Ships parked at OR inbound to this station — used to populate the
  // Traffic accordion and the right-of-head ship counter.
  const docked = ships.filter(s => !s.isTransit && s.origin === loc.id);
  const inbound = ships.filter(s => s.isTransit && s.destination === loc.id);
  const trafficShips = [
    ...docked.map(s => ({ marker: s, status: "docked" as const })),
    ...inbound.map(s => ({ marker: s, status: "inbound" as const })),
  ].sort((a, b) => a.marker.trader.name.localeCompare(b.marker.trader.name));

  return (
    <>
      <div
        className={`atlas-panel-head art-panel-head ${artUrl ? "" : "no-art"}`}
        style={artUrl ? artCardStyle(artUrl) : undefined}
      >
        <div className="atlas-detail-title">
          <span className="atlas-detail-eyebrow">Selected port</span>
          <span className="atlas-detail-name">{loc.name}</span>
        </div>
        <span className={`atlas-kind atlas-kind-${kind}`}>{kindLabel(kind)}</span>
      </div>

      <div className="atlas-detail-body">
        <div className="atlas-tags">
          {loc.traits.faction && <span className="atlas-tag faction">{loc.traits.faction}</span>}
          {loc.traits.tags.map(tag => <span key={tag} className="atlas-tag">{tag}</span>)}
        </div>

        <dl className="trade-helper-grid station-info-grid">
          <DetailStat label="tech" value={`L${loc.traits.techLevel}`} />
          <DetailStat label="population" value={formatPopulation(loc.population)} />
          <DetailStat label="routes" value={counts.routes.toLocaleString()} />
          <DetailStat label="docked" value={counts.docked.toLocaleString()} />
          <DetailStat label="inbound" value={counts.inbound.toLocaleString()} />
          <DetailStat label="contracts" value={counts.jobs.toLocaleString()} />
        </dl>

        <section className="trade-helper-section">
          <div className="exchange-section-title">Market pressure</div>
          {marketRowsTop.length === 0 ? (
            <div className="trade-helper-line muted"><span>Stock</span><span className="dim">balanced</span></div>
          ) : (
            marketRowsTop.map(row => (
              <div key={row.good} className={`trade-helper-line atlas-market-line ${row.tone}`}>
                <span>{row.name}</span>
                <span className="mono">
                  {row.stock.toFixed(0)} / {row.target.toFixed(0)}
                  <span className="dim"> · Ç{row.price.toFixed(1)}</span>
                </span>
              </div>
            ))
          )}
        </section>

        <section className="trade-helper-section">
          <div className="exchange-section-title">Traffic</div>
          {trafficShips.length === 0 ? (
            <div className="trade-helper-line muted"><span>Ships</span><span className="dim">none here</span></div>
          ) : (
            <TrafficList
              world={world}
              entries={trafficShips}
              selectedTraderId={selectedTraderId}
              onSelectTrader={onSelectTrader}
            />
          )}
        </section>
      </div>
    </>
  );
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="cargo-stat">
      <dt className="dim">{label}</dt>
      <dd className="mono info-value">{value}</dd>
    </div>
  );
}

// Single-open accordion of ships at the focused station. Mirrors the
// positions/orders accordions on the stock view: clicking a row toggles
// the expansion (and any other open row collapses).
function TrafficList(props: {
  world: World;
  entries: { marker: ShipMarker; status: "docked" | "inbound" }[];
  selectedTraderId: TraderId | null;
  onSelectTrader: (id: TraderId | null) => void;
}) {
  const [openId, setOpenId] = useState<TraderId | null>(null);
  return (
    <div className="atlas-traffic-list">
      {props.entries.map(({ marker, status }) => {
        const t = marker.trader;
        const isOpen = openId === t.id;
        const isSelected = props.selectedTraderId === t.id;
        const dst = t.destination ? props.world.locations[t.destination]?.name ?? "—" : null;
        const cargoQty = t.cargo.reduce((s, l) => s + l.qty, 0);
        return (
          <div key={t.id} className={`atlas-traffic-item ${status} ${isOpen ? "open" : ""} ${isSelected ? "selected" : ""}`}>
            <button type="button" className="atlas-traffic-summary" onClick={() => {
              setOpenId(isOpen ? null : t.id);
              props.onSelectTrader(t.id);
            }}>
              <span className={`atlas-traffic-pill ${status}`}>{status === "docked" ? "DOCK" : "INB"}</span>
              <span className="atlas-traffic-name">{t.name}</span>
              <span className="numeric mono dim">
                {status === "docked"
                  ? `${cargoQty.toFixed(0)}/${t.capacity} cargo`
                  : `ETA ${t.ticksRemaining}t`}
              </span>
            </button>
            {isOpen && (
              <div className="atlas-traffic-body">
                <div className="trade-helper-line"><span>Pilot</span><span className="mono">{t.pilot}</span></div>
                <div className="trade-helper-line"><span>Cargo</span><span className="mono">{cargoQty.toFixed(0)}/{t.capacity}</span></div>
                <div className="trade-helper-line"><span>Funds</span><span className="mono">Ç{Math.round(t.funds).toLocaleString()}</span></div>
                {status === "inbound" && dst && (
                  <div className="trade-helper-line"><span>From</span><span className="mono">{props.world.locations[t.location]?.name ?? "—"}</span></div>
                )}
                {t.cargo.length > 0 && (
                  <div className="trade-helper-line"><span>Holds</span><span className="mono">{t.cargo.map(l => `${props.world.goods[l.good]?.name ?? l.good} ×${Math.round(l.qty)}`).join(", ")}</span></div>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FlowText({ world, loc, goods }: { world: World; loc: LocationDef; goods: string[] }) {
  const visible = goods.slice(0, 3);
  return (
    <span className="atlas-flow-text">
      {visible.map(good => {
        const rate = netProductionRate(loc, good);
        return (
          <span key={good} title={`${world.goods[good]?.name ?? good} ${rate >= 0 ? "+" : ""}${rate.toFixed(1)}/t`}>
            <GiCargoCrate className="atlas-icon" aria-hidden="true" focusable="false" />
            {world.goods[good]?.name ?? good}
          </span>
        );
      })}
      {goods.length > visible.length && <span className="dim">+{goods.length - visible.length}</span>}
    </span>
  );
}

function stationCounts(world: World, id: LocationId) {
  const traders = Object.values(world.traders);
  return {
    docked: traders.filter(t => t.state === "idle" && t.location === id).length,
    inbound: traders.filter(t => t.state === "transit" && t.destination === id).length,
    jobs: Object.values(world.jobs).filter(j => j.destination === id && j.acceptedBy == null).length,
    routes: reachableNeighbors(world, id).length,
  };
}

function stationPressure(world: World, loc: LocationDef): StationPressure {
  const rows = marketRows(world, loc);
  const shortRows = rows.filter(r => r.tone === "short");
  const surplusRows = rows.filter(r => r.tone === "surplus");
  const focus = shortRows[0] ?? surplusRows[0] ?? rows[0];
  const flagged = [...shortRows, ...surplusRows];
  const avgSkew = flagged.length === 0
    ? 0
    : flagged.reduce((s, r) => s + Math.abs((r.price / r.base) - 1), 0) / flagged.length;
  return {
    short: shortRows.length,
    surplus: surplusRows.length,
    focusGood: focus?.name ?? "balanced",
    tone: shortRows.length > 0 ? "short" : surplusRows.length > 0 ? "surplus" : "",
    avgSkew,
  };
}

function marketRows(world: World, loc: LocationDef): MarketRow[] {
  const market = world.markets[loc.id];
  return Object.keys(world.goods).map(good => {
    const target = loc.targetStock[good] ?? 0;
    const stock = market.stock[good] ?? 0;
    const price = market.prices[good] ?? world.goods[good].basePrice;
    const base = world.goods[good].basePrice;
    const ratio = target > 0 ? stock / target : 1;
    const tone: MarketRow["tone"] = target > 0 && ratio < 0.45 ? "short" : target > 0 && ratio > 1.8 ? "surplus" : "";
    return { good, name: world.goods[good].name, stock, target, price, base, tone };
  }).filter(row => row.target > 0 || row.stock > 0.001)
    .sort((a, b) => {
      const aShort = a.tone === "short" ? 0 : 1;
      const bShort = b.tone === "short" ? 0 : 1;
      return aShort - bShort
        || Math.abs((b.price / b.base) - 1) - Math.abs((a.price / a.base) - 1)
        || a.name.localeCompare(b.name);
    });
}

function buildSheetRows(world: World, locations: LocationDef[]): StationSheetRow[] {
  return locations.map(loc => ({
    loc,
    kind: stationKind(loc),
    counts: stationCounts(world, loc.id),
    pressure: stationPressure(world, loc),
  })).sort((a, b) => {
    const pressureRank = Number(b.pressure.tone === "short") - Number(a.pressure.tone === "short");
    return pressureRank
      || stationSort(a.loc, b.loc);
  });
}

function projectLocations(locations: LocationDef[]): ProjectedLocation[] {
  if (locations.length === 0) return [];
  const xs = locations.map(l => l.position.x);
  const ys = locations.map(l => l.position.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const maxPop = Math.max(...locations.map(l => l.population), 1);

  return locations.map(loc => ({
    loc,
    x: MAP_PAD + ((loc.position.x - minX) / spanX) * (MAP_W - MAP_PAD * 2),
    y: MAP_H - (MAP_PAD + ((loc.position.y - minY) / spanY) * (MAP_H - MAP_PAD * 2)),
    r: 5 + (loc.population / maxPop) * 5 + loc.traits.techLevel * 0.22,
    kind: stationKind(loc),
  }));
}

function buildAtlasLinks(world: World, locations: LocationDef[]): AtlasLink[] {
  const ids = new Set(locations.map(loc => loc.id));
  return routeSegments(world)
    .filter(link => ids.has(link.a) && ids.has(link.b))
    .map(link => ({ a: link.a, b: link.b, dist: link.dist }));
}

function stationKind(loc: LocationDef): StationKind {
  const tags = loc.traits.tags;
  if (tags.includes("trade-hub")) return "hub";
  if (tags.includes("mining") || tags.includes("industrial")) return "mining";
  if (tags.includes("agricultural")) return "agri";
  if (tags.includes("frontier") || tags.includes("rim")) return "frontier";
  if (tags.includes("research") || tags.includes("high-tech")) return "research";
  return "station";
}

function kindLabel(kind: StationKind): string {
  switch (kind) {
    case "hub": return "Hub";
    case "mining": return "Industrial";
    case "agri": return "Agri";
    case "frontier": return "Frontier";
    case "research": return "Research";
    default: return "Station";
  }
}

function stationSort(a: LocationDef, b: LocationDef): number {
  const rank: Record<StationKind, number> = { hub: 0, research: 1, mining: 2, agri: 3, frontier: 4, station: 5 };
  return rank[stationKind(a)] - rank[stationKind(b)]
    || b.traits.techLevel - a.traits.techLevel
    || b.population - a.population
    || a.name.localeCompare(b.name);
}

function formatPopulation(population: number): string {
  return population >= 1000 ? `${(population / 1000).toFixed(1)}k` : population.toLocaleString();
}
