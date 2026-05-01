import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { IconType } from "react-icons";
import { GiAnvil, GiAtom, GiCampfire, GiMining, GiSpaceship, GiTrade, GiWheat } from "react-icons/gi";
import { useStore } from "../store";
import { findRoutePath, pathDistance, reachableNeighbors, routeDistance, routeSegments } from "../../sim/geometry";
import type { Equity, LocationDef, LocationId, Trader, TraderId, World } from "../../sim/types";
import { listHiresAt } from "../../sim/hires";
import { listShipyardInventory } from "../../sim/shipyards";
import { isUpgradeGood, upgradeDef } from "../../sim/upgrades";
import { parseBasisUnderlying, priceChangePct } from "../../sim/stock";
import { activeFuelType } from "../../sim/traders";
import { effectivePerDistance, ignoresFuel, travelTicksFor } from "../../sim/crew";
import { stationArtUrl } from "../art";
import { MiniSparkline } from "../components/MiniSparkline";
import { SortableRows, SortableTh } from "../components/SortableTable";
import { AtlasNewsPanel } from "./AtlasNewsPanel";
import "./LocationsView.css";

const MAP_W = 1000;
const MAP_H = 620;
const MAP_PAD = 48;

type StationKind = "hub" | "mining" | "agri" | "frontier" | "research" | "shipyard" | "station";
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
  exchange: StationExchangeSnapshot;
  hires: number;
  upgrades: number;
}

interface StationExchangeSnapshot {
  equity: Equity | null;
  changePct: number;
  treasuryRatio: number;
  netTradeFlow: number;
}

export function LocationsView() {
  const world = useStore((s) => s.world);
  const selectedLocation = useStore((s) => s.selectedLocation);
  const selectLocation = useStore((s) => s.selectLocation);
  const selectedTrader = useStore((s) => s.selectedTrader);
  const selectTrader = useStore((s) => s.selectTrader);
  useStore((s) => s.tickEpoch);

  // Sequence of LocationIds the SectorMap highlights when the user
  // hovers the Travel-here CTA on the detail panel. Set by the
  // detail panel, consumed by the map. Null when nothing is hovered.
  const [previewedRoute, setPreviewedRoute] = useState<LocationId[] | null>(null);

  const sheetTab = useStore((s) => s.atlasSheetTab);
  const setSheetTab = useStore((s) => s.setAtlasSheetTab);
  const newsCount = world.newsEvents?.active.length ?? 0;

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
        <aside className="atlas-side">
          <section className="atlas-map-panel">
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
              playerActiveRoute={buildActiveRoute(playerShip)}
              selectedTraderId={selectedTrader}
              previewedRoute={previewedRoute}
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
              <button
                type="button"
                className={`bridge-tab ${sheetTab === "news" ? "active" : ""}`}
                onClick={() => setSheetTab("news")}
              >
                Events <span className="atlas-tab-count">{newsCount}</span>
              </button>
            </div>

            <div className="atlas-table-scroll" data-scroll-key={`atlas:sheet:${sheetTab}`}>
              {sheetTab === "systems" && (
                <SystemsTable
                  rows={sheetRows}
                  selectedId={selected?.id ?? null}
                  onSelect={selectLocation}
                />
              )}
              {sheetTab === "ships" && (
                <ShipsTable
                  world={world}
                  selectedTraderId={selectedTrader}
                  onSelectTrader={selectTrader}
                  onSelectLocation={selectLocation}
                />
              )}
              {sheetTab === "news" && <AtlasNewsPanel world={world} onSelectLocation={selectLocation} />}
            </div>
          </section>
        </aside>

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
              onPreviewRoute={setPreviewedRoute}
            />
          ) : (
            <div className="atlas-detail-empty dim">Select a station from the map or list.</div>
          )}
        </section>
      </div>
    </section>
  );
}

// Full sequence of LocationIds the active player ship is travelling
// across — the current leg's destination first, then any waypoints
// queued on the trader's routePlan. Returned as null when the ship
// is idle so the map only highlights actively-pursued routes.
function buildActiveRoute(ship: Trader | null): LocationId[] | null {
  if (!ship || ship.state !== "transit" || !ship.destination) return null;
  const out: LocationId[] = [ship.destination];
  for (const id of ship.routePlan ?? []) out.push(id);
  return out;
}

function artCardStyle(url: string): CSSProperties {
  return { "--card-art": `url("${url}")` } as CSSProperties;
}

interface HoverTipRow { label: string; value: string; tone?: "good" | "bad" | "warn" }
interface HoverTip {
  px: number;
  py: number;
  title: string;
  meta?: string;
  art?: string;
  rows?: HoverTipRow[];
  icon?: ReactNode;
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
  playerActiveRoute,
  selectedTraderId,
  previewedRoute,
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
  // The list of LocationIds the player ship is currently travelling
  // through (next-hop first, final dst last). Null when the ship is
  // idle. The map renders the current leg and any queued waypoints
  // so multi-hop trips stay visible the whole way.
  playerActiveRoute: LocationId[] | null;
  selectedTraderId: TraderId | null;
  previewedRoute: LocationId[] | null;
  onSelect: (id: LocationId) => void;
  onSelectTrader: (id: TraderId | null) => void;
}) {
  // viewBox state drives pan/zoom — wheel zooms toward the cursor,
  // mouse drag pans, double-click resets.
  const svgRef = useRef<SVGSVGElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [vbox, setVbox] = useState({ x: 0, y: 0, w: MAP_W, h: MAP_H });
  const dragRef = useRef<{ sx: number; sy: number; vx: number; vy: number; moved: boolean } | null>(null);
  const [hover, setHover] = useState<HoverTip | null>(null);
  const [hoveredLane, setHoveredLane] = useState<string | null>(null);

  const peakLaneTraffic = Math.max(1, ...Array.from(laneTraffic.values()).map(t => t.count));
  const stars = useMemo(() => buildStarField(), []);

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

  const showTip = (e: React.MouseEvent, tip: Omit<HoverTip, "px" | "py">) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    setHover({ ...tip, px: e.clientX - rect.left, py: e.clientY - rect.top });
  };
  const moveTip = (e: React.MouseEvent) => {
    if (!hover) return;
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    setHover({ ...hover, px: e.clientX - rect.left, py: e.clientY - rect.top });
  };
  const hideTip = () => { setHover(null); setHoveredLane(null); };

  const playerOrigin = playerLocation ? projectedById.get(playerLocation) ?? null : null;
  void playerDestination;

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
        <rect className="atlas-map-bg" x={-MAP_W} y={-MAP_H} width={MAP_W * 3} height={MAP_H * 3} />
        <g className="atlas-stars">
          {stars.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.r} className={s.dim ? "dim" : undefined} />
          ))}
        </g>
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
            const key = laneKey(link.a, link.b);
            const traffic = laneTraffic.get(key);
            const intensity = traffic ? Math.min(1, 0.2 + (traffic.count / peakLaneTraffic) * 0.8) : 0.22;
            const isLong = link.dist > 90;
            const isHovered = hoveredLane === key;
            const cls = [
              "atlas-link",
              traffic && traffic.count > 0 ? "traffic" : null,
              isLong ? "long" : null,
              isHovered ? "hovered" : null,
            ].filter(Boolean).join(" ");
            return (
              <line
                key={key}
                className={cls}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                style={{ opacity: intensity }}
                onMouseEnter={(e) => {
                  setHoveredLane(key);
                  showTip(e, buildLaneTip(world, a, b, link.dist, traffic));
                }}
                onMouseMove={moveTip}
                onMouseLeave={hideTip}
              />
            );
          })}
        </g>
        {previewedRoute && previewedRoute.length >= 2 && (
          <g className="atlas-preview-route">
            {previewedRoute.slice(0, -1).map((from, i) => {
              const to = previewedRoute[i + 1];
              const a = projectedById.get(from);
              const b = projectedById.get(to);
              if (!a || !b) return null;
              return (
                <line
                  key={`preview-${from}-${to}`}
                  className="atlas-preview-link"
                  x1={a.x}
                  y1={a.y}
                  x2={b.x}
                  y2={b.y}
                />
              );
            })}
            {previewedRoute.map((id, i) => {
              const p = projectedById.get(id);
              if (!p) return null;
              return (
                <circle
                  key={`preview-node-${id}-${i}`}
                  className={`atlas-preview-node ${i === 0 ? "origin" : i === previewedRoute.length - 1 ? "dest" : "waypoint"}`}
                  cx={p.x}
                  cy={p.y}
                  r={i === 0 || i === previewedRoute.length - 1 ? p.r + 6 : p.r + 3}
                />
              );
            })}
          </g>
        )}
        {hoveredLane && (() => {
          // Inline distance label for the lane the cursor is over —
          // only shown on hover so the map doesn't fight the eye.
          const link = links.find(l => laneKey(l.a, l.b) === hoveredLane);
          if (!link) return null;
          const a = projectedById.get(link.a);
          const b = projectedById.get(link.b);
          if (!a || !b) return null;
          const mx = (a.x + b.x) / 2;
          const my = (a.y + b.y) / 2;
          return (
            <text className="atlas-lane-distance" x={mx} y={my}>{link.dist.toFixed(0)}u</text>
          );
        })()}
        {/* Direction arrows on lanes that have transit traffic — small
            chevron at the lane midpoint pointing toward the busier end. */}
        <g className="atlas-lane-arrows">
          {links.map(link => {
            const traffic = laneTraffic.get(laneKey(link.a, link.b));
            if (!traffic || traffic.count === 0) return null;
            const a = projectedById.get(link.a);
            const b = projectedById.get(link.b);
            if (!a || !b) return null;
            // Direction is set by the most-recent transit ship's heading.
            const heading = arrowHeading(world, traffic);
            if (!heading) return null;
            const fromP = heading === "ab" ? a : b;
            const toP = heading === "ab" ? b : a;
            return (
              <polygon
                key={`arrow-${laneKey(link.a, link.b)}`}
                className="atlas-lane-arrow"
                points={chevronPoints(fromP, toP)}
              />
            );
          })}
        </g>
        {playerOrigin && playerActiveRoute && playerActiveRoute.length > 0 && (() => {
          // Active travel path: ship → next-hop → ...waypoints → final
          // dst. Current leg keeps the prominent dashed accent so the
          // player sees what they're doing right now; queued waypoints
          // render with the lighter "upcoming" treatment so the rest
          // of the trip is visible without competing with the current
          // leg. Final destination gets a halo ring.
          const segments: { from: ProjectedLocation; to: ProjectedLocation; upcoming: boolean }[] = [];
          let prev = playerOrigin;
          for (let i = 0; i < playerActiveRoute.length; i++) {
            const next = projectedById.get(playerActiveRoute[i]);
            if (!next) continue;
            segments.push({ from: prev, to: next, upcoming: i > 0 });
            prev = next;
          }
          const finalDest = projectedById.get(playerActiveRoute[playerActiveRoute.length - 1]);
          return (
            <g className="atlas-player-route">
              {segments.map((seg, i) => (
                <line
                  key={`leg-${i}`}
                  className={seg.upcoming ? "atlas-player-route-leg upcoming" : "atlas-player-route-leg current"}
                  x1={seg.from.x}
                  y1={seg.from.y}
                  x2={seg.to.x}
                  y2={seg.to.y}
                />
              ))}
              {finalDest && (
                <circle
                  className="atlas-player-route-dest"
                  cx={finalDest.x}
                  cy={finalDest.y}
                  r={finalDest.r + 6}
                />
              )}
            </g>
          );
        })()}
        <g className="atlas-nodes">
          {projected.map(p => {
            const factionKey = factionClassKey(p.loc.traits.faction);
            return (
              <g
                key={p.loc.id}
                className={`atlas-node atlas-node-${p.kind} atlas-node-faction-${factionKey} ${selectedId === p.loc.id ? "selected" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => { if (!wasDrag()) onSelect(p.loc.id); }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(p.loc.id);
                  }
                }}
                onMouseEnter={(e) => showTip(e, buildStationTip(world, p))}
                onMouseMove={moveTip}
                onMouseLeave={hideTip}
              >
                <circle className="atlas-node-core" cx={p.x} cy={p.y} r={p.r} />
                {selectedId === p.loc.id && (
                  <circle className="atlas-node-ring" cx={p.x} cy={p.y} r={p.r + 5} />
                )}
              </g>
            );
          })}
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
                onMouseEnter={(e) => showTip(e, buildShipTip(world, ship))}
                onMouseMove={moveTip}
                onMouseLeave={hideTip}
              >
                {ship.isPlayer ? (
                  <path
                    className="atlas-player-marker"
                    d={`M ${ship.x} ${ship.y - 9} L ${ship.x + 9} ${ship.y} L ${ship.x} ${ship.y + 9} L ${ship.x - 9} ${ship.y} Z`}
                  />
                ) : ship.isTransit ? (
                  <ShipChevron
                    x={ship.x}
                    y={ship.y}
                    fromX={projectedById.get(ship.origin)?.x ?? ship.x}
                    fromY={projectedById.get(ship.origin)?.y ?? ship.y}
                    toX={ship.destination ? projectedById.get(ship.destination)?.x ?? ship.x : ship.x}
                    toY={ship.destination ? projectedById.get(ship.destination)?.y ?? ship.y : ship.y}
                  />
                ) : (
                  <circle cx={ship.x} cy={ship.y} r={2.6} />
                )}
                {isSelected && <circle className="atlas-ship-ring" cx={ship.x} cy={ship.y} r={11} />}
              </g>
            );
          })}
        </g>
      </svg>
      {hover && (
        <div className="atlas-tooltip" style={{ transform: `translate(${hover.px + 14}px, ${hover.py + 14}px)` }}>
          <div className="atlas-tooltip-head">
            {hover.art && (
              <span className="atlas-tooltip-thumb" style={{ backgroundImage: `url("${hover.art}")` }} />
            )}
            <span className="atlas-tooltip-title-block">
              <span className="atlas-tooltip-title">{hover.title}</span>
              {hover.meta && (
                <span className="atlas-tooltip-sub">
                  {hover.icon && <span className="atlas-tooltip-icon">{hover.icon}</span>}
                  {hover.meta}
                </span>
              )}
            </span>
          </div>
          {hover.rows && hover.rows.length > 0 && (
            <div className="atlas-tooltip-rows">
              {hover.rows.map((r, i) => (
                <div key={i} className="atlas-tooltip-row">
                  <span>{r.label}</span>
                  <span className={r.tone ?? ""}>{r.value}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// --- map background helpers ---------------------------------------------

interface StarSeed { x: number; y: number; r: number; dim: boolean }
function buildStarField(): StarSeed[] {
  // Deterministic — same starfield every render so the dust never
  // shimmers between ticks. 3x area so panning never finds an edge.
  const rng = mulberry32(0xa75a5);
  const out: StarSeed[] = [];
  const N = 260;
  for (let i = 0; i < N; i++) {
    out.push({
      x: -MAP_W + rng() * (MAP_W * 3),
      y: -MAP_H + rng() * (MAP_H * 3),
      r: 0.35 + rng() * 0.9,
      dim: rng() < 0.55,
    });
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function factionClassKey(faction: string | undefined): string {
  if (!faction) return "independent";
  return faction.toLowerCase().replace(/[^a-z]/g, "");
}

// --- lane direction arrow ------------------------------------------------

function arrowHeading(world: World, traffic: LaneTraffic): "ab" | "ba" | null {
  // Look at the most recent ship on the lane to set the chevron direction
  // (which leg of the lane is "outbound"). Stable enough for a glance cue
  // since multi-tick journeys keep the same direction the whole way.
  const t = world.traders[traffic.ships[traffic.ships.length - 1]];
  if (!t || t.state !== "transit" || !t.destination) return null;
  return t.location < t.destination ? "ab" : "ba";
}

function chevronPoints(from: ProjectedLocation, to: ProjectedLocation): string {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const tip = 5;
  const back = 4;
  const wing = 3.4;
  // Arrow points toward `to`. Tip ahead of midpoint; wings behind the
  // midpoint perpendicular to the lane.
  const tipX = mx + ux * tip;
  const tipY = my + uy * tip;
  const baseX = mx - ux * back;
  const baseY = my - uy * back;
  const px = -uy;
  const py = ux;
  return [
    `${tipX.toFixed(2)},${tipY.toFixed(2)}`,
    `${(baseX + px * wing).toFixed(2)},${(baseY + py * wing).toFixed(2)}`,
    `${(baseX - px * wing).toFixed(2)},${(baseY - py * wing).toFixed(2)}`,
  ].join(" ");
}

function ShipChevron({ x, y, fromX, fromY, toX, toY }: {
  x: number; y: number; fromX: number; fromY: number; toX: number; toY: number;
}) {
  // Render the transit ship as a chevron oriented along its lane so the
  // direction of motion reads at a glance, not just the position.
  const dx = toX - fromX;
  const dy = toY - fromY;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const ahead = 4.4;
  const behind = 3.2;
  const wing = 2.6;
  const tipX = x + ux * ahead;
  const tipY = y + uy * ahead;
  const baseX = x - ux * behind;
  const baseY = y - uy * behind;
  const points = [
    `${tipX.toFixed(2)},${tipY.toFixed(2)}`,
    `${(baseX + px * wing).toFixed(2)},${(baseY + py * wing).toFixed(2)}`,
    `${(baseX - px * wing).toFixed(2)},${(baseY - py * wing).toFixed(2)}`,
  ].join(" ");
  return <polygon className="atlas-ship-marker" points={points} />;
}

// --- tooltip builders ---------------------------------------------------

function buildStationTip(world: World, p: ProjectedLocation): Omit<HoverTip, "px" | "py"> {
  const counts = stationCounts(world, p.loc.id);
  const pressure = stationPressure(world, p.loc);
  const faction = p.loc.traits.faction ?? "Independent";
  const KindIcon = kindIcon(p.kind);
  const rows: HoverTipRow[] = [
    { label: "population", value: formatPopulation(p.loc.population) },
    { label: "tech", value: `L${p.loc.traits.techLevel}` },
    { label: "ships", value: `${counts.docked + counts.inbound}` },
    { label: "contracts", value: `${counts.jobs}` },
  ];
  if (pressure.short > 0 || pressure.surplus > 0) {
    rows.push({
      label: "pressure",
      value: pressure.tone === "short" ? `short ${pressure.focusGood}` : `surplus ${pressure.focusGood}`,
      tone: pressure.tone === "short" ? "bad" : "good",
    });
  }
  return {
    title: p.loc.name,
    meta: `${kindLabel(p.kind)} · ${faction}`,
    art: stationArtUrl(p.loc),
    icon: <KindIcon className={`atlas-tip-kind-icon atlas-tip-kind-${p.kind}`} aria-hidden="true" />,
    rows,
  };
}

function kindIcon(kind: StationKind): IconType {
  switch (kind) {
    case "hub":      return GiTrade;
    case "mining":   return GiMining;
    case "agri":     return GiWheat;
    case "frontier": return GiCampfire;
    case "research": return GiAtom;
    case "shipyard": return GiAnvil;
    default:         return GiSpaceship;
  }
}

function buildLaneTip(
  world: World,
  a: ProjectedLocation,
  b: ProjectedLocation,
  dist: number,
  traffic: LaneTraffic | undefined,
): Omit<HoverTip, "px" | "py"> {
  const rows: HoverTipRow[] = [
    { label: "distance", value: `${dist.toFixed(0)}u` },
    { label: "traffic", value: traffic ? `${traffic.count} ship${traffic.count === 1 ? "" : "s"}` : "none", tone: traffic && traffic.count > 0 ? "good" : undefined },
  ];
  if (traffic && traffic.ships.length > 0) {
    const names = traffic.ships
      .map(id => world.traders[id]?.name)
      .filter((n): n is string => Boolean(n))
      .slice(0, 2);
    if (names.length > 0) {
      const more = traffic.ships.length - names.length;
      rows.push({ label: "in transit", value: `${names.join(", ")}${more > 0 ? ` +${more}` : ""}` });
    }
  }
  return {
    title: `${a.loc.name} ↔ ${b.loc.name}`,
    meta: `Lane`,
    rows,
  };
}

function buildShipTip(world: World, ship: ShipMarker): Omit<HoverTip, "px" | "py"> {
  const t = ship.trader;
  const dst = ship.destination ? world.locations[ship.destination]?.name ?? "—" : null;
  const cargoQty = t.cargo.reduce((s, l) => s + l.qty, 0);
  const here = world.locations[ship.origin]?.name ?? "—";
  const rows: HoverTipRow[] = [];
  if (ship.isTransit && dst) {
    rows.push({ label: "from", value: here });
    rows.push({ label: "to", value: dst });
    rows.push({ label: "ETA", value: `${t.ticksRemaining}t` });
  } else {
    rows.push({ label: "docked", value: here });
  }
  rows.push({ label: "cargo", value: `${cargoQty.toFixed(0)} / ${t.capacity}` });
  rows.push({ label: "pilot", value: t.pilot });
  return {
    title: t.name,
    meta: `${ship.isPlayer ? "Player · " : ""}${ship.isTransit ? "transit" : "docked"}`,
    rows,
  };
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

// Systems sheet — exchange + logistics signals side by side. Class and
// focus columns dropped; replaced with equity Δ% and treasury health from
// the exchange, plus crew offers and upgrade-good counts from station
// logistics. Pressure remains as the trade-side market-stock summary.
function SystemsTable(props: {
  rows: StationSheetRow[];
  selectedId: LocationId | null;
  onSelect: (id: LocationId) => void;
}) {
  return (
    <SortableRows
      rows={props.rows}
      columns={[
        { id: "station", label: "station", getValue: row => row.loc.name },
        { id: "delta", label: "delta", getValue: row => row.exchange.equity ? row.exchange.changePct : null, defaultDirection: "desc" },
        { id: "treasury", label: "treasury", getValue: row => row.exchange.treasuryRatio, defaultDirection: "desc" },
        { id: "hires", label: "hires", getValue: row => row.hires, defaultDirection: "desc" },
        { id: "upgrades", label: "upgrades", getValue: row => row.upgrades, defaultDirection: "desc" },
        { id: "ships", label: "ships", getValue: row => row.counts.docked + row.counts.inbound, defaultDirection: "desc" },
        { id: "jobs", label: "jobs", getValue: row => row.counts.jobs, defaultDirection: "desc" },
        { id: "pressure", label: "pressure", getValue: row => (row.pressure.short + row.pressure.surplus) * 1000 + row.pressure.avgSkew, defaultDirection: "desc" },
      ]}
    >
      {(sortedRows, sort) => (
        <table className="atlas-sheet-table atlas-sheet-table-systems">
          <colgroup>
            <col className="col-station" />
            <col className="col-delta" />
            <col className="col-treasury" />
            <col className="col-hires" />
            <col className="col-upgrades" />
            <col className="col-ships" />
            <col className="col-jobs" />
            <col className="col-pressure" />
          </colgroup>
          <thead>
            <tr>
              <SortableTh sort={sort} columnId="station">Station</SortableTh>
              <SortableTh sort={sort} columnId="delta" className="numeric">Δ%</SortableTh>
              <SortableTh sort={sort} columnId="treasury" className="numeric">Treasury</SortableTh>
              <SortableTh sort={sort} columnId="hires" className="numeric">Crew</SortableTh>
              <SortableTh sort={sort} columnId="upgrades" className="numeric">Upg</SortableTh>
              <SortableTh sort={sort} columnId="ships" className="numeric">Ships</SortableTh>
              <SortableTh sort={sort} columnId="jobs" className="numeric">Jobs</SortableTh>
              <SortableTh sort={sort} columnId="pressure">Pressure</SortableTh>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map(row => {
              const selectedRow = props.selectedId === row.loc.id;
              const totalShips = row.counts.docked + row.counts.inbound;
              const eq = row.exchange.equity;
              const deltaPct = eq ? row.exchange.changePct * 100 : null;
              const deltaTone = deltaPct == null ? "dim" : deltaPct > 0.05 ? "good" : deltaPct < -0.05 ? "bad" : "dim";
              const treasuryPct = row.exchange.treasuryRatio * 100;
              const treasuryTone = treasuryPct >= 70 ? "good" : treasuryPct < 35 ? "bad" : "dim";
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
                  <td className="numeric mono">
                    {eq ? (
                      <span className={deltaTone}>
                        {deltaPct! > 0 ? "+" : ""}{deltaPct!.toFixed(2)}%
                      </span>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                  <td className="numeric mono">
                    <span className={treasuryTone}>{Math.round(treasuryPct)}%</span>
                  </td>
                  <td className="numeric mono">
                    <span className={row.hires > 0 ? "" : "dim"}>{row.hires}</span>
                  </td>
                  <td className="numeric mono">
                    <span className={row.upgrades > 0 ? "" : "dim"}>{row.upgrades}</span>
                  </td>
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
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </SortableRows>
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
    <SortableRows
      rows={ships}
      columns={[
        { id: "ship", label: "ship", getValue: ship => ship.name },
        { id: "state", label: "state", getValue: ship => ship.state === "transit" ? 0 : 1 },
        { id: "where", label: "location", getValue: ship => ship.destination ? props.world.locations[ship.destination]?.name ?? ship.destination : props.world.locations[ship.location]?.name ?? ship.location },
        { id: "eta", label: "eta", getValue: ship => ship.state === "transit" ? ship.ticksRemaining : null },
        { id: "cargo", label: "cargo", getValue: ship => ship.capacity > 0 ? ship.cargo.reduce((s, l) => s + l.qty, 0) / ship.capacity : 0, defaultDirection: "desc" },
        { id: "pilot", label: "pilot", getValue: ship => ship.pilot },
      ]}
    >
      {(sortedShips, sort) => (
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
              <SortableTh sort={sort} columnId="ship">Ship</SortableTh>
              <SortableTh sort={sort} columnId="state">State</SortableTh>
              <SortableTh sort={sort} columnId="where">Where</SortableTh>
              <SortableTh sort={sort} columnId="eta" className="numeric">ETA</SortableTh>
              <SortableTh sort={sort} columnId="cargo" className="numeric">Cargo</SortableTh>
              <SortableTh sort={sort} columnId="pilot">Pilot</SortableTh>
            </tr>
          </thead>
          <tbody>
            {sortedShips.map(t => {
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
      )}
    </SortableRows>
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
  onPreviewRoute: (path: LocationId[] | null) => void;
}) {
  const { world, loc, counts, marketRowsTop, stationKind: kind, ships, selectedTraderId, onSelectTrader, onPreviewRoute } = props;
  const artUrl = stationArtUrl(loc);

  // Ships parked at OR inbound to this station — used to populate the
  // Traffic accordion and the right-of-head ship counter.
  const docked = ships.filter(s => !s.isTransit && s.origin === loc.id);
  const inbound = ships.filter(s => s.isTransit && s.destination === loc.id);
  const trafficShips = [
    ...docked.map(s => ({ marker: s, status: "docked" as const })),
    ...inbound.map(s => ({ marker: s, status: "inbound" as const })),
  ].sort((a, b) => a.marker.trader.name.localeCompare(b.marker.trader.name));

  const exchange = stationExchangeSnapshot(world, loc);
  const localBasis = Object.values(world.equities)
    .filter(e => {
      if (e.kind !== "basis") return false;
      const parts = parseBasisUnderlying(e.underlyingId);
      return parts?.locationId === loc.id;
    })
    .sort((a, b) => Math.abs(b.price - b.anchorPrice) - Math.abs(a.price - a.anchorPrice))
    .slice(0, 4);
  const localFutures = Object.values(world.contracts ?? {})
    .filter(c => c.deliveryStation === loc.id)
    .sort((a, b) => a.expiryTick - b.expiryTick);
  const sparkPoints = (exchange.equity?.history ?? []).map(h => h.price);
  const lastDiv = exchange.equity?.lastDividend;
  const ticksSinceDiv = lastDiv ? Math.max(0, world.tick - lastDiv.tick) : null;
  const changeTone = exchange.changePct > 0.0005 ? "good" : exchange.changePct < -0.0005 ? "bad" : "";

  const hires = listHiresAt(world, loc.id);
  const hireRoles: Record<string, number> = {};
  for (const h of hires) hireRoles[h.role] = (hireRoles[h.role] ?? 0) + 1;

  const upgradeStock = upgradeStockAt(world, loc.id);
  const flowEntries = stationFlowEntries(world, loc).slice(0, 6);
  const stationNews = newsForLocation(world, loc.id);

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

      <div className="atlas-detail-body" data-scroll-key={`atlas:detail:${loc.id}`}>
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
          <DetailStat label="treasury" value={`${Math.round(exchange.treasuryRatio * 100)}%`} />
          <DetailStat label="net trade" value={fmtSignedFlow(exchange.netTradeFlow)} />
        </dl>

        <StationTravelAction world={world} loc={loc} onPreviewRoute={onPreviewRoute} />

        {exchange.equity && (
          <section className="trade-helper-section">
            <div className="exchange-section-title">Exchange</div>
            <div className="trade-helper-line station-exchange-quote">
              <span className="station-exchange-quote-left">
                <span className="station-exchange-ticker">{exchange.equity.ticker}</span>
                <span className="mono station-exchange-price">Ç{exchange.equity.price.toFixed(2)}</span>
              </span>
              <span className={`station-exchange-delta mono ${changeTone}`}>
                {exchange.changePct > 0 ? "+" : ""}{(exchange.changePct * 100).toFixed(2)}%
              </span>
            </div>
            {sparkPoints.length > 1 && (
              <MiniSparkline points={sparkPoints} className="station-exchange-spark" />
            )}
            {lastDiv && (
              <div className="trade-helper-line">
                <span>Last dividend</span>
                <span className="mono">Ç{lastDiv.perShare.toFixed(2)} / share · {ticksSinceDiv}t ago</span>
              </div>
            )}
            {localBasis.length > 0 && (
              <div className="trade-helper-line">
                <span>Basis spreads</span>
                <span className="station-basis-list">
                  {localBasis.map(b => {
                    const spread = b.price - b.anchorPrice;
                    const tone = spread > 0.001 ? "good" : spread < -0.001 ? "bad" : "";
                    return (
                      <span key={b.id} className="station-basis-chip">
                        <span className="mono">{b.ticker}</span>
                        <span className={`mono ${tone}`}>{spread > 0 ? "+" : ""}Ç{spread.toFixed(2)}</span>
                      </span>
                    );
                  })}
                </span>
              </div>
            )}
            {localFutures.length > 0 && (
              <div className="trade-helper-line">
                <span>Futures delivery</span>
                <span className="mono">
                  {localFutures.length} contract{localFutures.length === 1 ? "" : "s"}
                  {localFutures[0] && (
                    <> · next {Math.max(0, localFutures[0].expiryTick - world.tick)}t</>
                  )}
                </span>
              </div>
            )}
          </section>
        )}

        {flowEntries.length > 0 && (
          <section className="trade-helper-section">
            <div className="exchange-section-title">Production flow</div>
            <div className="atlas-flow-pills">
              {flowEntries.map(entry => (
                <span key={`${entry.kind}-${entry.good}`} className={`atlas-flow-pill ${entry.kind}`}>
                  <span className="atlas-flow-pill-rate mono">{entry.kind === "export" ? "+" : "−"}{entry.rate.toFixed(1)}/t</span>
                  <span className="atlas-flow-pill-name">{world.goods[entry.good]?.name ?? entry.good}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        {kind === "shipyard" && (
          <ShipyardMarketSection world={world} loc={loc} />
        )}

        <section className="trade-helper-section">
          <div className="exchange-section-title">Crew offers</div>
          {hires.length === 0 ? (
            <div className="trade-helper-line muted"><span>Hires</span><span className="dim">no postings</span></div>
          ) : (
            <>
              <div className="trade-helper-line">
                <span>Available</span>
                <span className="atlas-role-list">
                  {(["captain", "navigator", "mechanic"] as const).map(role => {
                    const n = hireRoles[role] ?? 0;
                    if (n === 0) return null;
                    return (
                      <span key={role} className="atlas-role-pill">
                        <span className="atlas-role-pill-label">{role}</span>
                        <span className="mono">{n}</span>
                      </span>
                    );
                  })}
                </span>
              </div>
              <div className="trade-helper-line">
                <span>Cheapest</span>
                <span className="mono">Ç{Math.min(...hires.map(h => h.hireCost)).toLocaleString()}</span>
              </div>
            </>
          )}
        </section>

        <section className="trade-helper-section">
          <div className="exchange-section-title">Upgrades in stock</div>
          {upgradeStock.length === 0 ? (
            <div className="trade-helper-line muted"><span>Stock</span><span className="dim">none on shelves</span></div>
          ) : (
            upgradeStock.slice(0, 6).map(row => (
              <div key={row.good} className="trade-helper-line">
                <span>{row.name}</span>
                <span className="mono">×{Math.floor(row.qty)} <span className="dim">· Ç{row.price.toFixed(0)}</span></span>
              </div>
            ))
          )}
        </section>

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

        {stationNews.length > 0 && (
          <section className="trade-helper-section">
            <div className="exchange-section-title">Active events</div>
            {stationNews.map(ev => (
              <div key={ev.uid} className={`atlas-detail-news tone-${ev.tone}`}>
                <div className="atlas-detail-news-head">
                  <span className="atlas-detail-news-tone" aria-hidden />
                  <span className="atlas-detail-news-cat">{ev.category}</span>
                  <span className="atlas-detail-news-ticks mono">{Math.max(0, ev.expiresAt - world.tick)}t</span>
                </div>
                <div className="atlas-detail-news-headline">{ev.headline}</div>
              </div>
            ))}
          </section>
        )}

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

interface FlowEntry { kind: "export" | "import"; good: string; rate: number }

function stationFlowEntries(world: World, loc: LocationDef): FlowEntry[] {
  const out: FlowEntry[] = [];
  for (const p of loc.produces) {
    const consumed = loc.consumes.find(c => c.good === p.good)?.ratePerTick ?? 0;
    const net = p.ratePerTick - consumed;
    if (net > 0.001) out.push({ kind: "export", good: p.good, rate: net });
  }
  for (const c of loc.consumes) {
    const produced = loc.produces.find(p => p.good === c.good)?.ratePerTick ?? 0;
    const net = c.ratePerTick - produced;
    if (net > 0.001) out.push({ kind: "import", good: c.good, rate: net });
  }
  void world;
  return out.sort((a, b) => b.rate - a.rate);
}

interface UpgradeStockRow { good: string; name: string; qty: number; price: number }

function upgradeStockAt(world: World, locId: LocationId): UpgradeStockRow[] {
  const market = world.markets[locId];
  if (!market) return [];
  const out: UpgradeStockRow[] = [];
  for (const good of Object.keys(market.stock)) {
    if (!isUpgradeGood(good)) continue;
    const qty = market.stock[good] ?? 0;
    if (qty < 1) continue;
    const def = world.goods[good];
    out.push({
      good,
      name: def?.name ?? good,
      qty,
      price: market.prices[good] ?? def?.basePrice ?? 0,
    });
  }
  return out.sort((a, b) => b.qty - a.qty);
}

function newsForLocation(world: World, locId: LocationId) {
  const active = world.newsEvents?.active ?? [];
  return active.filter(ev =>
    ev.effects.some(eff => eff.target.kind === "location" && eff.target.id === locId),
  );
}

function fmtSignedFlow(flow: number): string {
  if (Math.abs(flow) < 0.05) return "0";
  return `${flow > 0 ? "+" : ""}${flow.toFixed(1)}`;
}

function fmtCredits(amount: number): string {
  if (amount >= 1_000_000) return `Ç${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `Ç${(amount / 1_000).toFixed(0)}k`;
  return `Ç${amount.toLocaleString()}`;
}

// Shipyard marketplace section: lists ship blueprints for sale at the
// focused shipyard, lets the player click into one to see full stats /
// pre-installed upgrades / traits, and exposes the Buy action that
// debits the docked player ship's wallet.
function ShipyardMarketSection({ world, loc }: { world: World; loc: LocationDef }) {
  const blueprints = listShipyardInventory(world, loc.id);
  const purchaseShip = useStore(s => s.purchaseShip);
  const selectedTraderId = useStore(s => s.selectedTrader);
  const [openId, setOpenId] = useState<string | null>(null);

  const playerShipIds = world.player?.shipIds ?? [];
  // The "buying ship" is the picker selection if it's a player ship
  // docked here, otherwise the first player ship docked here. If no
  // player ship is at the shipyard, the Buy button is disabled.
  const dockedHere = playerShipIds
    .map(id => world.traders[id])
    .filter((t): t is Trader => Boolean(t) && t.state === "idle" && t.location === loc.id);
  const preferred = selectedTraderId && dockedHere.find(t => t.id === selectedTraderId);
  const buyer = preferred ?? dockedHere[0] ?? null;

  return (
    <section className="trade-helper-section atlas-shipyard-section">
      <div className="exchange-section-title">Shipyard inventory</div>
      {blueprints.length === 0 ? (
        <div className="trade-helper-line muted"><span>Inventory</span><span className="dim">no blueprints right now</span></div>
      ) : (
        <>
          <div className="trade-helper-line">
            <span>Buyer</span>
            <span className="mono">
              {buyer
                ? <>{buyer.name} · Ç{Math.floor(buyer.funds).toLocaleString()}</>
                : <span className="dim">dock a ship here to buy</span>}
            </span>
          </div>
          <div className="atlas-shipyard-list">
            {blueprints.map(bp => {
              const isOpen = openId === bp.id;
              const canAfford = buyer ? buyer.funds >= bp.price : false;
              const blockedReason = !buyer
                ? "Dock one of your ships at this shipyard to buy."
                : !canAfford
                  ? `${buyer.name} needs Ç${bp.price.toLocaleString()}, has Ç${Math.floor(buyer.funds).toLocaleString()}.`
                  : "";
              return (
                <div key={bp.id} className={`atlas-shipyard-item ${isOpen ? "open" : ""}`}>
                  <button
                    type="button"
                    className="atlas-shipyard-summary"
                    onClick={() => setOpenId(isOpen ? null : bp.id)}
                  >
                    <span className={`atlas-shipyard-class atlas-shipyard-class-${bp.class}`}>{bp.classLabel}</span>
                    <span className="atlas-shipyard-name">{bp.name}</span>
                    <span className="atlas-shipyard-price mono">{fmtCredits(bp.price)}</span>
                  </button>
                  {isOpen && (
                    <div className="atlas-shipyard-body">
                      <div className="atlas-shipyard-flavor dim">{bp.flavor}</div>
                      <dl className="trade-helper-grid atlas-shipyard-stats">
                        <DetailStat label="cargo" value={`${bp.baseCapacity}`} />
                        <DetailStat label="speed" value={`${bp.baseSpeed.toFixed(2)}`} />
                        <DetailStat label="fuel" value={`${bp.baseFuelCapacity}`} />
                        <DetailStat label="hull" value={`${bp.baseHull}`} />
                        <DetailStat label="weapons" value={`${bp.baseWeaponPower}`} />
                        <DetailStat label="fuel type" value={world.goods[bp.fuelType]?.name ?? bp.fuelType} />
                      </dl>
                      {Object.keys(bp.preInstalled).length > 0 && (
                        <div className="trade-helper-line">
                          <span>Pre-installed</span>
                          <span className="atlas-shipyard-upgrade-list">
                            {Object.values(bp.preInstalled).map(good => {
                              if (!good) return null;
                              const def = upgradeDef(good);
                              return (
                                <span key={good} className="atlas-shipyard-upgrade-chip" title={def?.description ?? def?.name ?? good}>
                                  {def?.name ?? good}
                                </span>
                              );
                            })}
                          </span>
                        </div>
                      )}
                      {bp.traits.length > 0 && (
                        <div className="trade-helper-line">
                          <span>Traits</span>
                          <span className="atlas-shipyard-trait-list">
                            {bp.traits.map(trait => (
                              <span key={trait} className="atlas-shipyard-trait-chip" title={traitDescription(trait)}>
                                {traitLabel(trait)}
                              </span>
                            ))}
                          </span>
                        </div>
                      )}
                      <div className="atlas-shipyard-buy-row">
                        <button
                          type="button"
                          className="atlas-shipyard-buy primary"
                          disabled={!buyer || !canAfford}
                          title={blockedReason}
                          onClick={() => {
                            if (!buyer || !canAfford) return;
                            if (!confirm(`Buy ${bp.name} (${bp.classLabel}) for Ç${bp.price.toLocaleString()}?\nFunds will be debited from ${buyer.name}.`)) return;
                            purchaseShip(bp.id);
                          }}
                        >
                          Buy for Ç{bp.price.toLocaleString()}
                        </button>
                        {!canAfford && buyer && (
                          <span className="atlas-shipyard-blocked dim">need Ç{(bp.price - buyer.funds).toLocaleString()} more</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

function traitLabel(trait: string): string {
  switch (trait) {
    case "self-piloted": return "Self-piloted";
    case "ai-navigator": return "AI navigator";
    case "extra-slot":   return "+1 upgrade slot";
    case "fuel-efficient": return "Fuel-efficient";
    case "rapid-unload":   return "Rapid unload";
    default: return trait;
  }
}

function traitDescription(trait: string): string {
  switch (trait) {
    case "self-piloted": return "Built-in pilot — runs without filling the captain crew slot.";
    case "ai-navigator": return "Built-in navigator — autopilot/guidance unlocks without a navigator crew member.";
    case "extra-slot":   return "Carries one bonus upgrade slot.";
    case "fuel-efficient": return "Burns less fuel per distance unit.";
    case "rapid-unload":   return "Unloads cargo faster at every dock.";
    default: return "";
  }
}

function DetailStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="cargo-stat">
      <dt className="dim">{label}</dt>
      <dd className="mono info-value">{value}</dd>
    </div>
  );
}

// "Travel here" CTA on the atlas station detail panel. Plots a
// shortest-path route through the lane network (multi-hop is fine —
// the trader auto-departs at each waypoint until it reaches the
// final destination), then mirrors travelTo()'s gating logic so the
// button disables itself with a clear reason for in-transit ships,
// missing routes, fuel shortfalls, or already-at-this-station.
// Hovering the button fires `onPreviewRoute(path)` so the SectorMap
// highlights the planned segments while the user decides.
function StationTravelAction({ world, loc, onPreviewRoute }: {
  world: World;
  loc: LocationDef;
  onPreviewRoute: (path: LocationId[] | null) => void;
}) {
  const travel = useStore(s => s.travel);
  const selectedTrader = useStore(s => s.selectedTrader);
  const player = world.player;
  if (!player) return null;
  const ids = player.shipIds;
  const ship = (selectedTrader && ids.includes(selectedTrader)
    ? world.traders[selectedTrader]
    : ids.map(id => world.traders[id]).find(Boolean)) ?? null;
  if (!ship) return null;

  const atDest = ship.location === loc.id && ship.state === "idle";
  const inTransit = ship.state === "transit";
  // Ship in transit but bound for this station — render the transit
  // status instead of a Depart button so the player can see the ETA.
  const inboundHere = inTransit && ship.destination === loc.id;
  const path = atDest ? null : findRoutePath(world, ship.location, loc.id);
  const totalDist = path && path.length >= 2 ? pathDistance(world, path) : null;
  const fuelFree = ignoresFuel(ship);
  const ft = activeFuelType(ship) ?? ship.fuelTypes[0] ?? null;
  const perDistance = ft ? effectivePerDistance(ship, ft.perDistance) : 0;
  const fuelNeeded = !fuelFree && totalDist != null ? totalDist * perDistance : 0;
  const fuelOnHand = ship.currentFuel?.qty ?? 0;
  const eta = totalDist != null ? travelTicksFor(ship, totalDist) : 0;
  const hopCount = path ? path.length - 1 : 0;

  let blockReason: string | null = null;
  if (atDest) blockReason = `${ship.name} is already at ${loc.name}.`;
  else if (inboundHere) blockReason = `${ship.name} is already inbound — ETA ${ship.ticksRemaining}t.`;
  else if (inTransit) blockReason = `${ship.name} is in transit, can't redirect.`;
  else if (!path || totalDist == null) blockReason = "No plotted route to this station.";
  else if (!fuelFree && fuelOnHand < fuelNeeded - 0.001) {
    blockReason = `Need ${fuelNeeded.toFixed(1)} fuel for the full route, ${ship.name} has ${fuelOnHand.toFixed(1)}.`;
  }
  const disabled = blockReason != null;

  const metaText = atDest
    ? "you are here"
    : inboundHere
      ? `inbound · ${ship.ticksRemaining}t`
      : totalDist == null
        ? "no route"
        : `${hopCount === 1 ? "1 hop" : `${hopCount} hops`} · ${totalDist.toFixed(1)}u · ${eta}t · ${fuelFree ? "no fuel" : `${fuelNeeded.toFixed(1)} ${ft?.good ?? "fuel"}`}`;

  // Only the route is allowed to "preview" on the map — failing
  // states (no route / not enough fuel / etc.) still surface the
  // path so the player can see why the trip is too long.
  const previewablePath = path && path.length >= 2 ? path : null;

  return (
    <div className="atlas-travel-action">
      <button
        type="button"
        className={`atlas-travel-btn ${disabled ? "disabled" : "primary"}`}
        disabled={disabled}
        title={blockReason ?? `Travel ${ship.name} to ${loc.name}`}
        onMouseEnter={() => onPreviewRoute(previewablePath)}
        onMouseLeave={() => onPreviewRoute(null)}
        onFocus={() => onPreviewRoute(previewablePath)}
        onBlur={() => onPreviewRoute(null)}
        onClick={() => {
          if (disabled) return;
          travel(ship.id, loc.id);
          onPreviewRoute(null);
        }}
      >
        <span className="atlas-travel-label">
          {atDest ? "Docked here" : inboundHere ? "Inbound" : `Travel ${ship.name}`}
        </span>
        <span className="atlas-travel-meta mono">{metaText}</span>
      </button>
      {blockReason && !atDest && !inboundHere && (
        <div className="atlas-travel-block dim">{blockReason}</div>
      )}
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
    exchange: stationExchangeSnapshot(world, loc),
    hires: listHiresAt(world, loc.id).length,
    upgrades: countUpgradesInStock(world, loc.id),
  })).sort((a, b) => {
    const pressureRank = Number(b.pressure.tone === "short") - Number(a.pressure.tone === "short");
    return pressureRank
      || stationSort(a.loc, b.loc);
  });
}

function stationExchangeSnapshot(world: World, loc: LocationDef): StationExchangeSnapshot {
  const equity = Object.values(world.equities)
    .find(e => e.kind === "station" && e.underlyingId === loc.id) ?? null;
  const market = world.markets[loc.id];
  const treasuryTarget = Math.max(1, market?.treasuryTarget ?? 0);
  const treasuryRatio = market ? (market.treasury ?? 0) / treasuryTarget : 0;
  return {
    equity,
    changePct: equity ? priceChangePct(equity) : 0,
    treasuryRatio,
    netTradeFlow: market?.netTradeFlow ?? 0,
  };
}

function countUpgradesInStock(world: World, locId: LocationId): number {
  const market = world.markets[locId];
  if (!market) return 0;
  let count = 0;
  for (const good of Object.keys(market.stock)) {
    if (!isUpgradeGood(good)) continue;
    if ((market.stock[good] ?? 0) >= 1) count += 1;
  }
  return count;
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
  // Match the canonical art helper: shipyard wins over the industrial/
  // research overlap so the marketplace UI keys off the same kind value.
  if (tags.includes("shipyard")) return "shipyard";
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
    case "shipyard": return "Shipyard";
    default: return "Station";
  }
}

function stationSort(a: LocationDef, b: LocationDef): number {
  const rank: Record<StationKind, number> = { hub: 0, research: 1, shipyard: 2, mining: 3, agri: 4, frontier: 5, station: 6 };
  return rank[stationKind(a)] - rank[stationKind(b)]
    || b.traits.techLevel - a.traits.techLevel
    || b.population - a.population
    || a.name.localeCompare(b.name);
}

function formatPopulation(population: number): string {
  return population >= 1000 ? `${(population / 1000).toFixed(1)}k` : population.toLocaleString();
}
