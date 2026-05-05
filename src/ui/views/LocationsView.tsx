import { memo, useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { IconType } from "react-icons";
import { GiAnvil, GiAtom, GiCampfire, GiMining, GiSpaceship, GiTrade, GiWheat } from "react-icons/gi";
import { useStore } from "../store";
import { useIsMobile } from "../useIsMobile";
import { defaultMobilePanelId } from "../mobilePanels";
import { findRoutePath, pathDistance, reachableNeighbors, routeDistance, routeSegments } from "../../sim/geometry";
import { playerReputationWith } from "../../sim/control";
import type { Equity, LocationDef, LocationId, ShipBlueprint, SyndicateId, Trader, TraderId, World } from "../../sim/types";
import { buildControlBoundaries, type ControlSource } from "./controlField";
import type { AtlasMapTab } from "../viewTabs";
import { ControlShareBar } from "../components/ControlShareBar";
import { listHiresAt } from "../../sim/hires";
import { listShipyardInventory } from "../../sim/shipyards";
import { useBlueprintArtImageUrl } from "../shipArtApi";
import { BuyShipModal } from "../components/BuyShipModal";
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

type StationKind = "hub" | "mining" | "agri" | "frontier" | "research" | "shipyard" | "outpost" | "station";
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
  // Snapshot tick-aligned position. Idle ships use their dock-grid
  // slot; transit ships use the lane-interpolated position at the
  // current tick. The map may smooth transit positions further with
  // sub-tick interpolation when the sim is running.
  x: number;
  y: number;
  // For idle ships, the projected station; for transit ships the lane
  // they're on. Used to drive lane-traffic shading and tooltips.
  origin: LocationId;
  destination: LocationId | null;
  isPlayer: boolean;
  isTransit: boolean;
  // Total ticks for the current leg + ticks-remaining on it. Only set
  // for transit ships; the map uses these to interpolate sub-tick
  // motion so the marker glides instead of jumping each tick.
  tripTotal?: number;
  ticksRemaining?: number;
}

interface LaneTraffic {
  count: number;
  // Outbound + inbound ships per lane regardless of direction. The map
  // shades lanes by this so corridors with traffic stand out.
  ships: TraderId[];
}

interface LaneDanger {
  // Encounters along this lane within the recent window — drives the
  // logistics tab's lane heatmap. Direction-agnostic: A→B and B→A coalesce.
  count: number;
}

// How far back (in ticks) the lane danger heatmap looks. 250 ticks is a
// rolling window short enough that a hot lane cools quickly when the
// activity moves elsewhere, but long enough that a single encounter
// doesn't disappear before the player notices it.
const LANE_DANGER_WINDOW_TICKS = 250;

// Live "ping" markers — encounters that fired within the last N ticks
// flash on the map at the lane midpoint, fading out over the window so the
// player can spot fresh hostile activity at a glance.
const ENCOUNTER_PING_TICKS = 20;

// Absolute thresholds for the lane danger color ramp:
//   <  DANGER_CALM_BELOW       → no tint (feels normal)
//   = DANGER_MEDIUM_AT          → midpoint (orange / dusty amber)
//   ≥ DANGER_HOT_AT             → fully red
// Two linear segments interpolate intensity 0..0.5 between calm→medium and
// 0.5..1 between medium→hot. Absolute (not relative-to-peak) so a lane
// with 6 encounters always reads the same regardless of fleet activity.
const DANGER_CALM_BELOW = 5;
const DANGER_MEDIUM_AT = 10;
const DANGER_HOT_AT = 20;

function laneDangerIntensity(count: number): number {
  if (count < DANGER_CALM_BELOW) return 0;
  if (count >= DANGER_HOT_AT) return 1;
  if (count <= DANGER_MEDIUM_AT) {
    return ((count - DANGER_CALM_BELOW) / (DANGER_MEDIUM_AT - DANGER_CALM_BELOW)) * 0.5;
  }
  return 0.5 + ((count - DANGER_MEDIUM_AT) / (DANGER_HOT_AT - DANGER_MEDIUM_AT)) * 0.5;
}

// Stations-tab lane color position. hop=1 → 0 (closest, near-white);
// hop=maxHop → 1 (furthest, light slate blue). Lanes interpolate between
// via OKLCH color-mix in CSS — opacity stays at 1 throughout, only the
// hue shifts. Player anchor's adjacent lanes (farHop=1) read brightest.
function laneHopRatio(hop: number, maxHop: number): number {
  if (maxHop <= 1) return 0;
  if (hop <= 1) return 0;
  return Math.min(1, (hop - 1) / (maxHop - 1));
}

interface EncounterPing {
  id: string;
  x: number;
  y: number;
  age: number;                 // ticks since spawn (0..ENCOUNTER_PING_TICKS)
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
  const tickEpoch = useStore((s) => s.tickEpoch);
  void tickEpoch;

  // Sequence of LocationIds the SectorMap highlights when the user
  // hovers the Travel-here CTA on the detail panel. Set by the
  // detail panel, consumed by the map. Null when nothing is hovered.
  const [previewedRoute, setPreviewedRoute] = useState<LocationId[] | null>(null);
  // Station id the systems / ships table is currently hovering. The
  // map mirrors that hover (crosshair on the station) so the player
  // can scan the table and locate stations spatially without having
  // to click each row. Cleared on row leave or table tab switch.
  const [externalHoveredId, setExternalHoveredId] = useState<LocationId | null>(null);

  const sheetTab = useStore((s) => s.atlasSheetTab);
  const setSheetTab = useStore((s) => s.setAtlasSheetTab);
  const mapTab = useStore((s) => s.atlasMapTab);
  const setMapTab = useStore((s) => s.setAtlasMapTab);
  const newsCount = world.newsEvents?.active.length ?? 0;
  const isMobile = useIsMobile();
  const mobilePanel = useStore(s => s.mobilePanel.locations ?? defaultMobilePanelId("locations") ?? "map");

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
  const ships = useMemo(() => buildShipMarkers(world, projectedById, links), [world, projectedById, links]);
  const laneTraffic = useMemo(() => buildLaneTraffic(world), [world]);
  const laneDanger = useMemo(() => buildLaneDanger(world), [world]);
  const encounterPings = useMemo(() => buildEncounterPings(world, projectedById), [world, projectedById]);
  const selectedMarket = selected ? marketRows(world, selected).slice(0, 9) : [];
  const selectedCounts = selected ? stationCounts(world, selected.id) : { docked: 0, inbound: 0, jobs: 0, routes: 0 };

  return (
    <section
      className={`atlas-view ${isMobile ? "mobile" : ""}`}
      data-mobile-panel={isMobile ? mobilePanel : undefined}
    >
      <div className="atlas-grid">
        <aside className="atlas-side">
          <section className="atlas-map-panel">
            <div className="atlas-map-tabs bridge-card-tabs">
              <button
                type="button"
                className={`bridge-tab ${mapTab === "stations" ? "active" : ""}`}
                onClick={() => setMapTab("stations")}
              >
                Stations
              </button>
              <button
                type="button"
                className={`bridge-tab ${mapTab === "syndicates" ? "active" : ""}`}
                onClick={() => setMapTab("syndicates")}
              >
                Syndicates
              </button>
              <button
                type="button"
                className={`bridge-tab ${mapTab === "logistics" ? "active" : ""}`}
                onClick={() => setMapTab("logistics")}
              >
                Logistics
              </button>
            </div>
            <SectorMap
              world={world}
              projected={projected}
              projectedById={projectedById}
              links={links}
              ships={ships}
              laneTraffic={laneTraffic}
              laneDanger={laneDanger}
              encounterPings={encounterPings}
              selectedId={selected?.id ?? null}
              playerLocation={playerShip?.location ?? null}
              playerDestination={playerShip?.state === "transit" ? playerShip.destination : null}
              playerActiveRoute={buildActiveRoute(playerShip)}
              selectedTraderId={selectedTrader}
              previewedRoute={previewedRoute}
              externalHoveredId={externalHoveredId}
              mapTab={mapTab}
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
                  world={world}
                  selectedId={selected?.id ?? null}
                  onSelect={selectLocation}
                  onHoverStation={setExternalHoveredId}
                />
              )}
              {sheetTab === "ships" && (
                <ShipsTable
                  world={world}
                  selectedTraderId={selectedTrader}
                  onSelectTrader={selectTrader}
                  onSelectLocation={selectLocation}
                  onHoverStation={setExternalHoveredId}
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
// Shortest distance from point (px, py) to the line segment a→b.
// Used by the atlas's lane-hover detection so we can pick the lane the
// cursor is actually closest to, even when multiple lane hit zones
// would otherwise overlap.
function perpDistanceToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

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
  title: string;
  meta?: string;
  art?: string;
  rows?: HoverTipRow[];
  icon?: ReactNode;
}

// Render order for station kinds inside the legend. Independent
// "station" sits last so the dominant kinds read first.
const KIND_LEGEND_ORDER: StationKind[] = ["outpost", "hub", "research", "shipyard", "mining", "agri", "frontier", "station"];

function SectorMap({
  world,
  projected,
  projectedById,
  links,
  ships,
  laneTraffic,
  laneDanger,
  encounterPings,
  selectedId,
  playerLocation,
  playerDestination,
  playerActiveRoute,
  selectedTraderId,
  previewedRoute,
  externalHoveredId,
  mapTab,
  onSelect,
  onSelectTrader,
}: {
  world: World;
  projected: ProjectedLocation[];
  projectedById: Map<LocationId, ProjectedLocation>;
  links: AtlasLink[];
  ships: ShipMarker[];
  laneTraffic: Map<string, LaneTraffic>;
  // Per-lane recent-encounter density. Tints lanes red on the logistics
  // tab to flag dangerous corridors.
  laneDanger: Map<string, LaneDanger>;
  // Recently-fired encounters as positioned pings — pulse + fade out over
  // ENCOUNTER_PING_TICKS so the player spots fresh hostile activity.
  encounterPings: EncounterPing[];
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
  // Station id the systems / ships sheet is currently hovering — the
  // map mirrors it as a crosshair so the player can scan the table
  // and locate stations spatially. Null when nothing is row-hovered.
  externalHoveredId: LocationId | null;
  mapTab: AtlasMapTab;
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
  // The station the cursor is currently over. Drives the crosshair +
  // coordinate readout that's the centerpiece of the atlas treatment.
  const [hoveredStation, setHoveredStation] = useState<ProjectedLocation | null>(null);
  // Effective hover for crosshair display: cursor wins, otherwise the
  // sheet table's row hover stands in. Render-only — the cursor logic
  // (hit-test, click delegate) keeps reading the internal hoveredStation
  // because the table-driven hover doesn't carry a click.
  const externalHoveredProj = externalHoveredId ? projectedById.get(externalHoveredId) ?? null : null;
  const effectiveHoveredStation = hoveredStation ?? externalHoveredProj;
  // Legend-driven kind filter. Toggled kinds ghost out on the map
  // but stay clickable so the user can flip them back.
  const [hiddenKinds, setHiddenKinds] = useState<Set<StationKind>>(() => new Set());
  const toggleKind = (kind: StationKind) => {
    setHiddenKinds(prev => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const peakLaneTraffic = Math.max(1, ...Array.from(laneTraffic.values()).map(t => t.count));

  // Syndicate accent map — used by the control-bubble field, station
  // border tints, and ship chevron tints. Keyed by SyndicateId so each
  // layer can opt into the lookup. Recomputed only when world.syndicates
  // changes (typically once per game).
  const syndicateAccents = useMemo(() => {
    const m = new Map<SyndicateId, string>();
    for (const synd of Object.values(world.syndicates)) {
      if (synd.accentHex) m.set(synd.id, synd.accentHex);
    }
    return m;
  }, [world.syndicates]);

  // Lane render order drives the bridge illusion: shorter lanes draw
  // last so their paper-coloured outline erases the longer lane's ink
  // at intersections, making the shorter (local) lane appear to bridge
  // over the longer (long-haul) one. Stable secondary sort by lane key
  // keeps the order deterministic.
  const orderedLinks = useMemo(() => {
    return [...links].sort((a, b) => b.dist - a.dist || laneKey(a.a, a.b).localeCompare(laneKey(b.a, b.b)));
  }, [links]);

  // Undirected adjacency: station id → set of directly-connected station
  // ids. Used by the stations-mode filter to expand from the player's
  // active ship + selected station into 1- and 2-hop neighbourhoods.
  const neighborMap = useMemo(() => {
    const m = new Map<LocationId, Set<LocationId>>();
    for (const link of links) {
      const a = m.get(link.a) ?? new Set<LocationId>();
      a.add(link.b);
      m.set(link.a, a);
      const b = m.get(link.b) ?? new Set<LocationId>();
      b.add(link.a);
      m.set(link.b, b);
    }
    return m;
  }, [links]);

  // The station the player's active ship is anchored to. When docked
  // that's playerLocation; when in transit it's the destination they're
  // about to arrive at, which is more useful context than "where they
  // left from". Null when the player has no ship at all.
  const playerAnchor = playerDestination ?? playerLocation ?? null;

  // Stations-mode visibility expansion. Three tiers from the player
  // anchor; selecting a station only contributes one hop on top.
  //   lvl1 = playerAnchor ∪ neighbours(playerAnchor) ∪ selectedId ∪ neighbours(selectedId)
  // BFS hop distance from the player's anchor station to every reachable
  // station. Used by the stations tab to fade lanes / station markers
  // continuously by hop distance — no hard hop limit. Stations in a
  // disconnected component aren't in the map; downstream uses treat them
  // as the maximum hop distance so they fade to the same minimum.
  const hopFromAnchor = useMemo(() => {
    const m = new Map<LocationId, number>();
    if (!playerAnchor) return m;
    m.set(playerAnchor, 0);
    let frontier: LocationId[] = [playerAnchor];
    while (frontier.length > 0) {
      const next: LocationId[] = [];
      for (const id of frontier) {
        const dist = m.get(id) ?? 0;
        for (const n of neighborMap.get(id) ?? []) {
          if (!m.has(n)) {
            m.set(n, dist + 1);
            next.push(n);
          }
        }
      }
      frontier = next;
    }
    return m;
  }, [playerAnchor, neighborMap]);

  const maxHopReachable = useMemo(() => {
    let max = 0;
    for (const v of hopFromAnchor.values()) if (v > max) max = v;
    return max;
  }, [hopFromAnchor]);

  // Per-tab visible lane set + two per-lane signals on the stations tab:
  //   laneHop:    BFS distance from the player anchor (0=closest, 1=far),
  //               drives the lane's *opacity* falloff.
  //   laneLength: the lane's own geographic distance (0=shortest in the
  //               sector, 1=longest), drives the *colour* — white for
  //               short links, lighter slate blue for long ones.
  // Other tabs return empty maps; the danger heatmap on Logistics drives
  // its own colouring.
  const { visibleLinks, laneHop, laneLength } = useMemo(() => {
    if (mapTab === "syndicates") {
      return {
        visibleLinks: [] as AtlasLink[],
        laneHop: new Map<string, number>(),
        laneLength: new Map<string, number>(),
      };
    }
    if (mapTab !== "stations") {
      return {
        visibleLinks: orderedLinks,
        laneHop: new Map<string, number>(),
        laneLength: new Map<string, number>(),
      };
    }
    // Compute min/max link distance once so the per-lane normalization
    // covers the full sector spread without flattening at the bottom or
    // saturating at the top.
    let minDist = Infinity;
    let maxDist = 0;
    for (const link of orderedLinks) {
      if (link.dist < minDist) minDist = link.dist;
      if (link.dist > maxDist) maxDist = link.dist;
    }
    const lengthSpan = Math.max(0.0001, maxDist - minDist);
    const hop = new Map<string, number>();
    const length = new Map<string, number>();
    for (const link of orderedLinks) {
      const aHop = hopFromAnchor.get(link.a);
      const bHop = hopFromAnchor.get(link.b);
      const farHop = Math.max(
        aHop ?? maxHopReachable,
        bHop ?? maxHopReachable,
      );
      const key = laneKey(link.a, link.b);
      hop.set(key, laneHopRatio(farHop, maxHopReachable));
      length.set(key, Math.min(1, Math.max(0, (link.dist - minDist) / lengthSpan)));
    }
    return { visibleLinks: orderedLinks, laneHop: hop, laneLength: length };
  }, [mapTab, orderedLinks, hopFromAnchor, maxHopReachable]);

  // Set of lane keys + endpoint stations that are currently rendered —
  // used to filter ships so we only show ones whose route is on screen.
  // A docked ship counts as "on a visible route" if its station has at
  // least one visible lane attached. The player's own ship always shows
  // regardless of tier so the player can locate themselves.
  const { visibleLaneKeys, visibleStations } = useMemo(() => {
    const keys = new Set<string>();
    const stations = new Set<LocationId>();
    for (const link of visibleLinks) {
      keys.add(laneKey(link.a, link.b));
      stations.add(link.a);
      stations.add(link.b);
    }
    return { visibleLaneKeys: keys, visibleStations: stations };
  }, [visibleLinks]);

  // Route from the player ship's current dock to the selected station.
  // Always rendered when a station other than the player's is selected
  // (white animated line, see CSS), and overridden by previewedRoute
  // when the user hovers the Travel CTA (blue). Null when there's no
  // ship, no selection, or the player is already at the destination.
  const selectedRoute = useMemo(() => {
    if (!playerLocation || !selectedId || selectedId === playerLocation) return null;
    const path = findRoutePath(world, playerLocation, selectedId);
    return path && path.length >= 2 ? path : null;
  }, [world, playerLocation, selectedId]);

  // Whichever route to show. Travel-button hover wins over selection
  // because it's the more recent intent. Tag the variant for styling.
  const displayedRoute = previewedRoute ?? selectedRoute;
  const displayedRouteIsPreview = previewedRoute !== null;

  // Stations stay fully opaque on the stations tab — only the lane colour
  // shifts with hop distance. Hop information was previously plumbed
  // through stationFade; that's now dropped.

  // Per-tab visible ship set. Stations: only ships whose lane (or dock
  // station) is part of the visible network. Syndicates: no docked
  // ships, transit only — they're "in space". Logistics: full set.
  const visibleShips = useMemo(() => {
    if (mapTab === "logistics") return ships;
    if (mapTab === "syndicates") return ships.filter(s => s.isTransit || s.isPlayer);
    // stations:
    return ships.filter(s => {
      if (s.isPlayer) return true;
      if (s.isTransit) {
        if (!s.destination) return false;
        return visibleLaneKeys.has(laneKey(s.origin, s.destination));
      }
      return visibleStations.has(s.origin);
    });
  }, [mapTab, ships, visibleLaneKeys, visibleStations]);

  // In logistics mode, override the syndicate accent palette with a
  // reputation-based palette: red (hostile) → amber (neutral) → green
  // (trusted). The same Map<SyndicateId, string> shape is consumed by
  // every layer (stations, ships, control bubbles), so the rep colours
  // light everything up in the same encoding without per-layer plumbing.
  const displayAccents = useMemo(() => {
    if (mapTab !== "logistics") return syndicateAccents;
    const m = new Map<SyndicateId, string>();
    for (const synd of Object.values(world.syndicates)) {
      const rep = playerReputationWith(world, synd.id);
      m.set(synd.id, repColor(rep));
    }
    return m;
  }, [mapTab, syndicateAccents, world]);

  // SVG text scales with the viewBox, so HUD text needs a font-size in
  // user units that compensates for current zoom to stay visually
  // around 11px. 0.011 ≈ 11px when the SVG is rendered at MAP_W
  // pixels wide (which it is at 1x zoom).
  const hudFontSize = vbox.w * 0.011;

  const applyZoom = (clientX: number, clientY: number, factor: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    // Use the SVG screen-CTM to convert cursor → viewBox space. The
    // naive form (clientX/rect.width * vbox.w) ignores the letterbox
    // that xMidYMid-meet introduces when panel aspect ≠ viewBox aspect,
    // which makes zoom-around-cursor drift off-target on one axis.
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const local = pt.matrixTransform(ctm.inverse());
    const cx = local.x;
    const cy = local.y;
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
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const drag = dragRef.current;
    if (drag) {
      // xMidYMid-meet uses the *smaller* of (rect.w/vbox.w, rect.h/vbox.h)
      // on both axes and letterboxes the other. Splitting the deltas by
      // independent per-axis ratios under-translates whichever axis has
      // padding, so a 1px mouse move covered <1px of world. Using the
      // single fit-scale keeps pan exactly 1:1 with the cursor.
      const fitScale = Math.min(rect.width / vbox.w, rect.height / vbox.h);
      const dx = (e.clientX - drag.sx) / fitScale;
      const dy = (e.clientY - drag.sy) / fitScale;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true;
      setVbox({ x: drag.vx - dx, y: drag.vy - dy, w: vbox.w, h: vbox.h });
      return;
    }
    // Hover detection. Stations always win over lanes — if the cursor
    // is within STATION_HIT_RADIUS of any station glyph, that station
    // is hovered and lane detection short-circuits. Otherwise lanes
    // fall through to the perpendicular-band test.
    //
    // Coordinate conversion uses the SVG's screen-CTM rather than
    // rect-relative math — preserveAspectRatio="xMidYMid meet" letter-
    // boxes the viewBox inside the element, so the naive form was off
    // by the band height/width whenever the element aspect didn't match.
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const inv = ctm.inverse();
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const local = pt.matrixTransform(inv);
    const px = local.x;
    const py = local.y;

    // 1) Station hover — generous radius so stations grab the cursor
    //    well before lanes do. Closest-by-distance wins among candidates.
    const STATION_HIT_RADIUS = vbox.w * 0.034; // ~34px screen-equiv at default zoom
    const STATION_HIT_RADIUS_SQ = STATION_HIT_RADIUS * STATION_HIT_RADIUS;
    let bestStation: ProjectedLocation | null = null;
    let bestStationDistSq = STATION_HIT_RADIUS_SQ;
    for (const p of projected) {
      const dx = p.x - px;
      const dy = p.y - py;
      const distSq = dx * dx + dy * dy;
      if (distSq < bestStationDistSq) {
        bestStationDistSq = distSq;
        bestStation = p;
      }
    }
    if (bestStation) {
      if (!hoveredStation || hoveredStation.loc.id !== bestStation.loc.id) {
        setHoveredStation(bestStation);
        showTip(buildStationTip(world, bestStation));
      }
      if (hoveredLane) setHoveredLane(null);
      return;
    }
    if (hoveredStation) {
      setHoveredStation(null);
      setHover(null);
    }

    // 2) Lane hover — score = perpDistance + length * LENGTH_WEIGHT.
    //    Closeness to the cursor still leads, but a shorter lane gets
    //    a small bias so it tends to win against a near-equally-close
    //    longer one (which routinely passes through clusters where
    //    short local lanes also exist).
    //    Only walk currently-visible lanes — in the syndicates tab
    //    nothing renders, so hover should be a no-op there too;
    //    otherwise off-screen lanes would still highlight invisibly.
    const HIGHLIGHT_BAND = vbox.w * 0.022; // ~22px screen-equiv at default zoom
    const LENGTH_WEIGHT = 0.2;
    let bestKey: string | null = null;
    let bestScore = Infinity;
    let bestLink: AtlasLink | null = null;
    for (const link of visibleLinks) {
      const a = projectedById.get(link.a);
      const b = projectedById.get(link.b);
      if (!a || !b) continue;
      const perp = perpDistanceToSegment(px, py, a.x, a.y, b.x, b.y);
      if (perp >= HIGHLIGHT_BAND) continue;
      const score = perp + link.dist * LENGTH_WEIGHT;
      if (score < bestScore) { bestScore = score; bestKey = laneKey(link.a, link.b); bestLink = link; }
    }
    if (bestKey !== hoveredLane) {
      if (bestKey && bestLink) {
        const a = projectedById.get(bestLink.a)!;
        const b = projectedById.get(bestLink.b)!;
        onLaneEnter(bestKey, a, b, bestLink.dist, laneTraffic.get(bestKey), laneDanger.get(bestKey));
      } else if (hoveredLane) {
        setHoveredLane(null);
        setHover(null);
      }
    }
  };
  const releaseDrag = () => { dragRef.current = null; };
  const onDoubleClick = () => setVbox({ x: 0, y: 0, w: MAP_W, h: MAP_H });

  // The wasDrag check (drag-then-release shouldn't count as a click)
  // lives on a ref so the memoized layers can reach it without
  // re-rendering on every drag-induced state change.

  // Tooltips are pinned in the corner of the map (atlas treatment), so
  // the hover handler just sets the content — no cursor coordinates.
  // The handlers are wrapped in useCallback so the memoized layer
  // components don't re-render every time the parent does (e.g. on
  // pan/zoom) just because the inline-arrow handler reference shifts.
  const showTip = useCallback((tip: HoverTip) => setHover(tip), []);
  const hideTip = useCallback(() => {
    setHover(null);
    setHoveredLane(null);
    setHoveredStation(null);
  }, []);

  // Stable hover/click callbacks for the memoized layers. All three
  // close over `world`/`onSelect`/`onSelectTrader` so they need to
  // re-create when those change, but not when vbox or hover state
  // changes — which is the whole point of memoising the layers.
  const onLaneEnter = useCallback((key: string, a: ProjectedLocation, b: ProjectedLocation, dist: number, traffic: LaneTraffic | undefined, danger: LaneDanger | undefined) => {
    setHoveredLane(key);
    showTip(buildLaneTip(world, a, b, dist, traffic, danger));
  }, [world, showTip]);

  const onEnterStation = useCallback((p: ProjectedLocation) => {
    setHoveredStation(p);
    showTip(buildStationTip(world, p));
  }, [world, showTip]);

  const onSelectStation = useCallback((id: LocationId) => {
    if (dragRef.current?.moved === true) return;
    onSelect(id);
  }, [onSelect]);

  const onClickShip = useCallback((id: TraderId, e: React.MouseEvent) => {
    if (dragRef.current?.moved === true) return;
    e.stopPropagation();
    onSelectTrader(id);
  }, [onSelectTrader]);

  const onEnterShip = useCallback((ship: ShipMarker) => {
    showTip(buildShipTip(world, ship));
  }, [world, showTip]);

  const playerOrigin = playerLocation ? projectedById.get(playerLocation) ?? null : null;
  void playerDestination;

  return (
    <div ref={wrapRef} className={`atlas-map-wrap mode-${mapTab}`}>
      <svg
        className="atlas-map atlas-map-grid"
        viewBox={`${vbox.x} ${vbox.y} ${vbox.w} ${vbox.h}`}
        aria-hidden="true"
      >
        <rect className="atlas-map-bg" x={-MAP_W} y={-MAP_H} width={MAP_W * 3} height={MAP_H * 3} />
        <g className="atlas-gridlines">
          {/* Grid stops are computed against the current vbox so the
              lines extend to the visible canvas at any zoom or pan
              level — the universe-bounded frame still sits inside as
              an indicator of the original gen window. Step values
              match the legacy 10-cell minor / 4-cell major rhythm. */}
          {(() => {
            const minorStepX = MAP_W / 10;
            const minorStepY = MAP_H / 10;
            const majorStepX = MAP_W / 4;
            const majorStepY = MAP_H / 4;
            const stops = (start: number, end: number, step: number): number[] => {
              const out: number[] = [];
              const first = Math.floor(start / step) * step;
              for (let v = first; v <= end + step * 0.5; v += step) out.push(v);
              return out;
            };
            // Generate stops + draw lines well past the viewBox — the
            // SVG defaults to xMidYMid-meet which letterboxes the
            // viewBox inside the element, so lines that span only
            // [vbox.x..vbox.x+vbox.w] would clip at the inner edge of
            // the letterbox. Extending by 4× lets the SVG's overflow:
            // hidden clip at the actual canvas edge instead.
            const padX = vbox.w * 4;
            const padY = vbox.h * 4;
            const x1 = vbox.x - padX;
            const x2 = vbox.x + vbox.w + padX;
            const y1 = vbox.y - padY;
            const y2 = vbox.y + vbox.h + padY;
            const minorXs = stops(x1, x2, minorStepX);
            const minorYs = stops(y1, y2, minorStepY);
            const majorXs = stops(x1, x2, majorStepX);
            const majorYs = stops(y1, y2, majorStepY);
            return (
              <>
                {minorXs.map(x => (
                  <line key={`mnx-${x}`} className="atlas-gridline-minor" x1={x} y1={y1} x2={x} y2={y2} />
                ))}
                {minorYs.map(y => (
                  <line key={`mny-${y}`} className="atlas-gridline-minor" x1={x1} y1={y} x2={x2} y2={y} />
                ))}
                {majorXs.map(x => (
                  <line key={`mjx-${x}`} className="atlas-gridline-major" x1={x} y1={y1} x2={x} y2={y2} />
                ))}
                {majorYs.map(y => (
                  <line key={`mjy-${y}`} className="atlas-gridline-major" x1={x1} y1={y} x2={x2} y2={y} />
                ))}
              </>
            );
          })()}
        </g>
        {(() => {
          // Crosshair lives in the grid SVG (unmasked) rather than the
          // data SVG so the dashed lines stay full-strength right to
          // the panel edges, like the gridlines themselves — the data
          // SVG vignette would otherwise fade them out 75px from each
          // side. Drawn after the gridlines so it sits on top of them.
          //
          // Selected-station crosshair stays on always (dim), hover
          // overlays a brighter version. When the cursor is over the
          // selected station, the hover variant alone reads — render
          // them in order so the hover style wins at the same lines.
          //
          // The SVG defaults to preserveAspectRatio="xMidYMid meet"
          // which letterboxes the viewBox inside the element, so a
          // line spanning [vbox.x, vbox.x + vbox.w] only covers the
          // centered viewBox region. Extending the endpoints by a
          // generous margin past the viewBox lets the SVG's own
          // overflow:hidden clip the line at the actual element edge,
          // which is what the player sees as "the canvas edge".
          const xLeft = vbox.x - vbox.w * 4;
          const xRight = vbox.x + vbox.w * 5;
          const yTop = vbox.y - vbox.h * 4;
          const yBot = vbox.y + vbox.h * 5;
          const selectedProj = selectedId ? projectedById.get(selectedId) ?? null : null;
          const showSelected = selectedProj && (!effectiveHoveredStation || effectiveHoveredStation.loc.id !== selectedProj.loc.id);
          return (
            <>
              {showSelected && selectedProj && (
                <g
                  className={`atlas-crosshair selected ${selectedProj.loc.id === playerLocation ? "player" : ""}`}
                  pointerEvents="none"
                >
                  <line className="atlas-crosshair-line" x1={selectedProj.x} y1={yTop} x2={selectedProj.x} y2={yBot} />
                  <line className="atlas-crosshair-line" x1={xLeft} y1={selectedProj.y} x2={xRight} y2={selectedProj.y} />
                </g>
              )}
              {effectiveHoveredStation && (
                <g className={`atlas-crosshair ${effectiveHoveredStation.loc.id === playerLocation ? "player" : ""}`} pointerEvents="none">
                  <line
                    className="atlas-crosshair-line"
                    x1={effectiveHoveredStation.x}
                    y1={yTop}
                    x2={effectiveHoveredStation.x}
                    y2={yBot}
                  />
                  <line
                    className="atlas-crosshair-line"
                    x1={xLeft}
                    y1={effectiveHoveredStation.y}
                    x2={xRight}
                    y2={effectiveHoveredStation.y}
                  />
                  <TextBadge
                    className="atlas-crosshair-coord"
                    text={`x ${formatAtlasCoord(effectiveHoveredStation.loc.position.x)}`}
                    cx={effectiveHoveredStation.x}
                    cy={vbox.y + vbox.h - hudFontSize * 7.5}
                    fontSize={hudFontSize}
                  />
                  <TextBadge
                    className="atlas-crosshair-coord"
                    text={`y ${formatAtlasCoord(effectiveHoveredStation.loc.position.y)}`}
                    cx={vbox.x + hudFontSize * 7.5}
                    cy={effectiveHoveredStation.y}
                    fontSize={hudFontSize}
                  />
                </g>
              )}
            </>
          );
        })()}
      </svg>
      <svg
        ref={svgRef}
        className="atlas-map atlas-map-data"
        viewBox={`${vbox.x} ${vbox.y} ${vbox.w} ${vbox.h}`}
        role="img"
        aria-label="Station map"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={releaseDrag}
        onMouseLeave={() => { releaseDrag(); hideTip(); }}
        onClick={() => {
          // SVG-level click delegates to whichever station is currently
          // hovered, so the click hit-zone matches the wider hover
          // radius rather than just the drawn glyph. A click on the
          // glyph itself still fires the inner <g>'s onClick first;
          // since onSelect is idempotent the duplicate is harmless.
          if (dragRef.current?.moved === true) return;
          if (hoveredStation) onSelectStation(hoveredStation.loc.id);
        }}
        onDoubleClick={onDoubleClick}
      >
        {(mapTab === "syndicates" || mapTab === "logistics") && (
          <ControlBubblesLayer
            projected={projected}
            syndicateAccents={displayAccents}
            controlState={world.control}
            controlVersion={world.controlVersion ?? 0}
          />
        )}
        <LanesLayer
          orderedLinks={visibleLinks}
          laneHop={laneHop}
          laneLength={laneLength}
          projectedById={projectedById}
          laneTraffic={laneTraffic}
          peakLaneTraffic={peakLaneTraffic}
          laneDanger={laneDanger}
          alwaysTintDanger={mapTab === "logistics"}
          hoveredLane={hoveredLane}
        />
        {mapTab === "logistics" && encounterPings.length > 0 && (
          <PingsLayer pings={encounterPings} />
        )}
        {displayedRoute && displayedRoute.length >= 2 && (
          <g className={`atlas-preview-route ${displayedRouteIsPreview ? "preview" : "selected"}`}>
            {displayedRoute.slice(0, -1).map((from, i) => {
              const to = displayedRoute[i + 1];
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
            {displayedRoute.map((id, i) => {
              const p = projectedById.get(id);
              if (!p) return null;
              return (
                <circle
                  key={`preview-node-${id}-${i}`}
                  className={`atlas-preview-node ${i === 0 ? "origin" : i === displayedRoute.length - 1 ? "dest" : "waypoint"}`}
                  cx={p.x}
                  cy={p.y}
                  r={i === 0 || i === displayedRoute.length - 1 ? p.r + 6 : p.r + 3}
                />
              );
            })}
          </g>
        )}
        {hoveredLane && visibleLaneKeys.has(hoveredLane) && (() => {
          // Inline distance label for the lane the cursor is over —
          // only shown on hover so the map doesn't fight the eye.
          // Gated on visibleLaneKeys so a stale hover persisting from
          // before a tab switch doesn't paint a label on a lane that
          // isn't even rendered.
          const link = links.find(l => laneKey(l.a, l.b) === hoveredLane);
          if (!link) return null;
          const a = projectedById.get(link.a);
          const b = projectedById.get(link.b);
          if (!a || !b) return null;
          const label = `${link.dist.toFixed(0)}u`;
          return (
            <TextBadge
              className="atlas-lane-distance"
              text={label}
              cx={(a.x + b.x) / 2}
              cy={(a.y + b.y) / 2}
              fontSize={hudFontSize}
            />
          );
        })()}
        {/* Crosshair (selected + hover) renders in the grid SVG above
            so it stays unmasked and reaches the panel edges. */}
        {/* Lane-midpoint direction arrows were dropped here — the
            transit-ship chevrons themselves show heading now that
            sub-tick smoothing makes them glide along the lane. */}
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
        {/* Ships render BEFORE stations so a transit ship sitting on
            top of its origin/destination station is visually tucked
            behind the station glyph — only the station icon shows
            when ship and station overlap. */}
        <ShipsLayer
          ships={visibleShips}
          projectedById={projectedById}
          selectedTraderId={selectedTraderId}
          syndicateAccents={displayAccents}
          onClickShip={onClickShip}
          onEnterShip={onEnterShip}
          onLeave={hideTip}
        />
        <StationsLayer
          projected={projected}
          selectedId={selectedId}
          playerLocation={playerLocation}
          hiddenKinds={hiddenKinds}
          syndicateAccents={displayAccents}
          // Stations tab paints markers via station-kind defaults rather
          // than syndicate accents — the syndicates tab is where faction
          // colours belong.
          showFactionAccent={mapTab !== "stations"}
          onSelect={onSelectStation}
          onEnter={onEnterStation}
          onLeave={hideTip}
        />
      </svg>
      <div className="atlas-legend">
        {mapTab === "stations" && (
          <>
            <span className="atlas-legend-title">Stations</span>
            <ul className="atlas-legend-list">
              {KIND_LEGEND_ORDER.map(kind => {
                const off = hiddenKinds.has(kind);
                return (
                  <li key={kind} style={{ display: "contents" }}>
                    <button
                      type="button"
                      className={`atlas-legend-row ${off ? "off" : ""}`}
                      onClick={() => toggleKind(kind)}
                      aria-pressed={!off}
                    >
                      <span className={`atlas-legend-dot atlas-kind-${kind}`} />
                      <span className="atlas-legend-label">{kindLabel(kind)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <span className="atlas-legend-title">Lane length</span>
            <div className="atlas-legend-ramp">
              <div className="atlas-legend-ramp-bar hop" aria-hidden="true" />
              <div className="atlas-legend-ramp-labels">
                <span>short</span>
                <span>long</span>
              </div>
            </div>
            <span className="atlas-legend-title">From your ship</span>
            <div className="atlas-legend-ramp">
              <div className="atlas-legend-ramp-bar hop-opacity" aria-hidden="true" />
              <div className="atlas-legend-ramp-labels">
                <span>nearby</span>
                <span>far</span>
              </div>
            </div>
          </>
        )}
        {mapTab === "syndicates" && syndicateAccents.size > 0 && (
          <>
            <span className="atlas-legend-title">Syndicates</span>
            <ul className="atlas-legend-list">
              {Object.values(world.syndicates)
                .filter(s => s.accentHex)
                .sort((a, b) => a.id.localeCompare(b.id))
                .map(synd => (
                  <li key={synd.id} style={{ display: "contents" }}>
                    <div className="atlas-legend-row syndicate">
                      <span
                        className="atlas-legend-dot"
                        style={{ background: synd.accentHex } as CSSProperties}
                      />
                      <span className="atlas-legend-label">{synd.name}</span>
                    </div>
                  </li>
                ))}
            </ul>
          </>
        )}
        {mapTab === "logistics" && (
          <>
            <span className="atlas-legend-title">Reputation</span>
            <ul className="atlas-legend-list">
              {[
                { label: "Stranger", t: 0 },
                { label: "Known", t: 0.5 },
                { label: "Trusted", t: 1 },
              ].map(({ label, t }) => (
                <li key={label} style={{ display: "contents" }}>
                  <div className="atlas-legend-row syndicate">
                    <span
                      className="atlas-legend-dot"
                      style={{ background: repColor(t) } as CSSProperties}
                    />
                    <span className="atlas-legend-label">{label}</span>
                  </div>
                </li>
              ))}
            </ul>
            <span className="atlas-legend-title">Lane danger</span>
            <div className="atlas-legend-ramp">
              <div className="atlas-legend-ramp-bar" aria-hidden="true" />
              <div className="atlas-legend-ramp-labels">
                <span>calm</span>
                <span>hotspot</span>
              </div>
            </div>
          </>
        )}
      </div>
      {hover && (
        <div className="atlas-tooltip">
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

// Format a world-space coordinate for display in the crosshair
// readout — signed, padded to 5 visual columns so labels of different
// magnitudes line up under each other in the same eye fixation.
function formatAtlasCoord(value: number): string {
  const sign = value >= 0 ? "+" : "−";
  const abs = Math.abs(value).toFixed(1).padStart(4, "0");
  return `${sign}${abs}`;
}

function factionClassKey(faction: string | undefined): string {
  if (!faction) return "independent";
  return faction.toLowerCase().replace(/[^a-z]/g, "");
}

// Resolve a station/ship's faction id to a human label. Falls back to
// the raw value (or "Independent") when the syndicate isn't registered
// — happens with old saves predating the syndicate roster, or with
// shipyards/unfactioned stations.
function factionLabel(world: World, factionId: string | undefined): string {
  if (!factionId) return "Independent";
  return world.syndicates[factionId]?.name ?? factionId;
}


// --- memoized SVG layers -------------------------------------------------
// The three layers below are wrapped in React.memo so a state change
// confined to the SectorMap (pan/zoom, hover, kind filter, tooltip
// content) doesn't reconcile every lane/station/ship in the tree.
// The lane network and station list are stable across pans, and the
// ship layer only re-renders when the snapshot changes (per tick).

interface ControlBubblesLayerProps {
  projected: ProjectedLocation[];
  syndicateAccents: Map<SyndicateId, string>;
  controlState: World["control"];
  controlVersion: number;
}

// Per-syndicate territory boundaries, extracted from a sampled
// dominant-syndicate field via marching squares and smoothed with
// Chaikin corner-cutting. Each syndicate gets one <path> with its accent
// stroke; fill defaults to none but stays available via the
// --control-bubble-fill CSS variable on .atlas-control-boundary so the
// shape can be styled either as a clean outline or as a tinted region.
// Boundaries naturally close at the grid edge (the outermost lattice
// row/col is forced to "no syndicate" by the sampler). Memoised on
// (projected, syndicateAccents, controlVersion) — pan/zoom doesn't
// recompute, but a tick that nudges control bumps the version and
// the field rebuilds on the next paint.
const ControlBubblesLayer = memo(function ControlBubblesLayer({
  projected, syndicateAccents, controlState, controlVersion,
}: ControlBubblesLayerProps) {
  const boundaries = useMemo(() => {
    if (syndicateAccents.size === 0) return [];
    // Below this share, a station's contribution to a rival syndicate
    // is too small to materially shape the boundary — drop it to keep
    // the source list tight and stop long-tail noise from haloing the
    // whole map.
    const MIN_SHARE_FOR_RENDER = 0.05;
    const sources: ControlSource[] = [];
    for (const p of projected) {
      const ctrl = controlState?.[p.loc.id];
      if (ctrl) {
        for (const synd in ctrl) {
          if (!syndicateAccents.has(synd)) continue;
          const share = ctrl[synd];
          if (share < MIN_SHARE_FOR_RENDER) continue;
          sources.push({ x: p.x, y: p.y, syndicateId: synd, control: share });
        }
      } else {
        // Fallback for old saves / shipyards / first-touch stations:
        // assume 100% control to whoever's stamped on the faction.
        const synd = p.loc.traits.faction;
        if (!synd || !syndicateAccents.has(synd)) continue;
        sources.push({ x: p.x, y: p.y, syndicateId: synd, control: 1.0 });
      }
    }
    if (sources.length === 0) return [];
    const ids = Array.from(syndicateAccents.keys());
    return buildControlBoundaries(sources, ids, MAP_W, MAP_H);
    // controlState is mutated in place per tick — depending on its
    // identity alone would never invalidate the memo, so we co-list
    // controlVersion (bumped on every nudge/decay).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projected, syndicateAccents, controlState, controlVersion]);

  if (boundaries.length === 0) return null;
  return (
    <g className="atlas-control-bubbles" pointerEvents="none">
      {boundaries.map(b => {
        const accent = syndicateAccents.get(b.syndicateId);
        return (
          <path
            key={b.syndicateId}
            className="atlas-control-boundary"
            d={b.pathD}
            stroke={accent}
            fill="none"
            fillRule="evenodd"
            vectorEffect="non-scaling-stroke"
            style={accent ? { "--syndicate-accent": accent } as CSSProperties : undefined}
          />
        );
      })}
    </g>
  );
});

interface LanesLayerProps {
  orderedLinks: AtlasLink[];
  projectedById: Map<LocationId, ProjectedLocation>;
  laneTraffic: Map<string, LaneTraffic>;
  peakLaneTraffic: number;
  laneDanger: Map<string, LaneDanger>;
  // Logistics tab paints every lane on the danger ramp (zero-encounter
  // lanes show as calm green); other tabs only tint when there's actual
  // activity, falling back to the neutral atlas-ink default.
  alwaysTintDanger: boolean;
  hoveredLane: string | null;
  // Per-lane opacity ratio (0=closest, 1=furthest from player anchor).
  // Drives stroke-opacity on the Stations tab so distant lanes fade.
  laneHop: Map<string, number>;
  // Per-lane length ratio (0=shortest sector link, 1=longest). Drives
  // stroke colour on the Stations tab so short hops read white and long
  // hops read slate blue.
  laneLength: Map<string, number>;
}

// Lane render-only. Hover detection lives on the parent SVG's
// mousemove handler, which walks every lane and picks the one whose
// perpendicular distance to the cursor is smallest — overlapping lanes
// can't both highlight at once. Per-line SVG hit-zones were removed
// for the same reason.
const LanesLayer = memo(function LanesLayer({
  orderedLinks, projectedById, laneTraffic, peakLaneTraffic, laneDanger, alwaysTintDanger, hoveredLane, laneHop, laneLength,
}: LanesLayerProps) {
  return (
    <g className="atlas-lanes" pointerEvents="none">
      {orderedLinks.map(link => {
        const a = projectedById.get(link.a);
        const b = projectedById.get(link.b);
        if (!a || !b) return null;
        const key = laneKey(link.a, link.b);
        const traffic = laneTraffic.get(key);
        const intensity = traffic ? Math.min(1, 0.5 + (traffic.count / peakLaneTraffic) * 0.5) : 0;
        const danger = laneDanger.get(key);
        const dangerIntensity = danger ? laneDangerIntensity(danger.count) : 0;
        const isHovered = hoveredLane === key;
        const hop = laneHop.get(key);
        const length = laneLength.get(key);
        const cls = [
          "atlas-lane",
          traffic && traffic.count > 0 ? "traffic" : null,
          // Danger tint is logistics-tab only — that's where the heatmap
          // legend sits and where the green→amber→red read is wanted.
          alwaysTintDanger ? "danger" : null,
          // Stations tab opts every lane into the white→slate-blue
          // length ramp + the player-distance opacity falloff.
          hop !== undefined ? "hop-ramp" : null,
          isHovered ? "hovered" : null,
        ].filter(Boolean).join(" ");
        return (
          <g
            key={key}
            className={cls}
            style={{
              "--lane-traffic-intensity": intensity,
              "--lane-danger-intensity": dangerIntensity,
              "--lane-hop": hop ?? 0,
              "--lane-length": length ?? 0,
            } as CSSProperties}
          >
            <line className="atlas-lane-outline" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            <line className="atlas-lane-inner" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
          </g>
        );
      })}
    </g>
  );
});

// Live encounter pings — small pulsing red markers that fade out over
// ENCOUNTER_PING_TICKS. Each ping wraps in a translated <g> so the ring's
// CSS scale animation rotates around the marker's center (the inner
// circle's local origin) rather than the SVG's (0,0).
const PingsLayer = memo(function PingsLayer({ pings }: { pings: EncounterPing[] }) {
  return (
    <g className="atlas-pings" pointerEvents="none">
      {pings.map(p => {
        const lifeFrac = Math.max(0, 1 - p.age / ENCOUNTER_PING_TICKS);
        return (
          <g
            key={p.id}
            className="atlas-ping"
            transform={`translate(${p.x}, ${p.y})`}
            style={{ opacity: lifeFrac } as CSSProperties}
          >
            <circle r="2.4" className="atlas-ping-ring" />
            <circle r="1.2" className="atlas-ping-core" />
          </g>
        );
      })}
    </g>
  );
});

interface StationsLayerProps {
  projected: ProjectedLocation[];
  selectedId: LocationId | null;
  playerLocation: LocationId | null;
  hiddenKinds: Set<StationKind>;
  syndicateAccents: Map<SyndicateId, string>;
  // Whether station markers should pick up their syndicate's accent.
  // Stations tab disables it so markers render with kind-default colours;
  // syndicates / logistics tabs leave it on.
  showFactionAccent: boolean;
  onSelect: (id: LocationId) => void;
  onEnter: (p: ProjectedLocation) => void;
  onLeave: () => void;
}

const StationsLayer = memo(function StationsLayer({
  projected, selectedId, playerLocation, hiddenKinds, syndicateAccents, showFactionAccent, onSelect, onEnter, onLeave,
}: StationsLayerProps) {
  return (
    <g className="atlas-nodes">
      {projected.map(p => {
        const factionKey = factionClassKey(p.loc.traits.faction);
        const accent = showFactionAccent && p.loc.traits.faction
          ? syndicateAccents.get(p.loc.traits.faction)
          : null;
        const isPlayerHere = playerLocation === p.loc.id;
        const isFiltered = hiddenKinds.has(p.kind);
        const cls = [
          "atlas-node",
          `atlas-node-${p.kind}`,
          `atlas-node-faction-${factionKey}`,
          selectedId === p.loc.id ? "selected" : null,
          isPlayerHere ? "player-here" : null,
          isFiltered ? "filtered" : null,
        ].filter(Boolean).join(" ");
        return (
          <g
            key={p.loc.id}
            className={cls}
            style={accent ? { "--node-faction": accent } as CSSProperties : undefined}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(p.loc.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(p.loc.id);
              }
            }}
            onMouseEnter={() => onEnter(p)}
            onMouseLeave={onLeave}
          >
            <circle className="atlas-node-halo" cx={p.x} cy={p.y} r={p.r + 2.5} />
            <circle className="atlas-node-core" cx={p.x} cy={p.y} r={p.r} />
            {(selectedId === p.loc.id || isPlayerHere) && (
              <circle className="atlas-node-ring" cx={p.x} cy={p.y} r={p.r + 4} />
            )}
          </g>
        );
      })}
    </g>
  );
});

interface ShipsLayerProps {
  ships: ShipMarker[];
  projectedById: Map<LocationId, ProjectedLocation>;
  selectedTraderId: TraderId | null;
  syndicateAccents: Map<SyndicateId, string>;
  onClickShip: (id: TraderId, e: React.MouseEvent) => void;
  onEnterShip: (ship: ShipMarker) => void;
  onLeave: () => void;
}

const ShipsLayer = memo(function ShipsLayer({
  ships, projectedById, selectedTraderId, syndicateAccents, onClickShip, onEnterShip, onLeave,
}: ShipsLayerProps) {
  return (
    <g className="atlas-ships">
      {ships.map(ship => {
        const isSelected = selectedTraderId === ship.id;
        const heading = shipHeading(ship, projectedById);
        const synd = ship.trader.syndicateId;
        const accent = synd ? syndicateAccents.get(synd) : null;
        return (
          <g
            key={ship.id}
            className={`atlas-ship ${ship.isTransit ? "transit" : "idle"} ${ship.isPlayer ? "player" : ""} ${isSelected ? "selected" : ""}`}
            style={accent ? { "--ship-faction": accent } as CSSProperties : undefined}
            transform={`translate(${ship.x.toFixed(2)} ${ship.y.toFixed(2)})`}
            onClick={(e) => onClickShip(ship.id, e)}
            onMouseEnter={() => onEnterShip(ship)}
            onMouseLeave={onLeave}
          >
            {ship.isPlayer ? (
              <polygon
                className="atlas-player-marker"
                points={playerTrianglePoints(heading.dx, heading.dy)}
              />
            ) : ship.isTransit ? (
              <ShipChevron dx={heading.dx} dy={heading.dy} />
            ) : (
              <circle className="atlas-ship-glyph" cx={0} cy={0} r={2.4} />
            )}
          </g>
        );
      })}
    </g>
  );
});

// Centered-text badge with a rounded-rect background. Used for the
// lane-distance label and the crosshair coord readouts so the text
// has a discrete background instead of a stroke-halo painted on the
// glyphs themselves.
function TextBadge({ className, text, cx, cy, fontSize }: {
  className: string;
  text: string;
  cx: number;
  cy: number;
  fontSize: number;
}) {
  // Mono char width is ~0.6 of font-size; vertical box is the
  // font-size with a comfortable amount of padding above and below.
  const charW = fontSize * 0.6;
  const padX = fontSize * 0.65;
  const padY = fontSize * 0.40;
  const w = text.length * charW + padX * 2;
  const h = fontSize + padY * 2;
  return (
    <g className={`atlas-text-badge ${className}`}>
      <rect
        className="atlas-text-badge-bg"
        x={cx - w / 2}
        y={cy - h / 2}
        width={w}
        height={h}
        rx={fontSize * 0.3}
      />
      <text className="atlas-text-badge-label" x={cx} y={cy} fontSize={fontSize}>{text}</text>
    </g>
  );
}

function ShipChevron({ dx, dy }: { dx: number; dy: number }) {
  // Render the transit ship as a chevron oriented along its lane so the
  // direction of motion reads at a glance. The polygon sits at (0, 0);
  // the parent <g> handles positioning via CSS transform so motion
  // transitions smoothly between ticks.
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const ahead = 4.0;
  const behind = 2.8;
  const wing = 2.4;
  const points = [
    `${(ux * ahead).toFixed(2)},${(uy * ahead).toFixed(2)}`,
    `${(-ux * behind + px * wing).toFixed(2)},${(-uy * behind + py * wing).toFixed(2)}`,
    `${(-ux * behind - px * wing).toFixed(2)},${(-uy * behind - py * wing).toFixed(2)}`,
  ].join(" ");
  return <polygon className="atlas-ship-glyph" points={points} />;
}

// Heading vector (dest - origin) for a ship marker. Transit ships
// face along their lane; idle ships face up by default. Returned as
// a unit-magnitude pair the polygon helpers can rotate around.
function shipHeading(ship: ShipMarker, projectedById: Map<LocationId, ProjectedLocation>): { dx: number; dy: number } {
  if (!ship.isTransit || !ship.destination) return { dx: 0, dy: -1 };
  const a = projectedById.get(ship.origin);
  const b = projectedById.get(ship.destination);
  if (!a || !b) return { dx: 0, dy: -1 };
  return { dx: b.x - a.x, dy: b.y - a.y };
}

// Triangle polygon for the player ship — apex points along the
// heading vector. The polygon is rendered at (0, 0); the parent <g>
// translates the ship into position via CSS transform so motion can
// transition smoothly between ticks.
function playerTrianglePoints(dx: number, dy: number): string {
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const ahead = 7.5;
  const behind = 5;
  const wing = 4.6;
  return [
    `${(ux * ahead).toFixed(2)},${(uy * ahead).toFixed(2)}`,
    `${(-ux * behind + px * wing).toFixed(2)},${(-uy * behind + py * wing).toFixed(2)}`,
    `${(-ux * behind - px * wing).toFixed(2)},${(-uy * behind - py * wing).toFixed(2)}`,
  ].join(" ");
}

// --- tooltip builders ---------------------------------------------------

function buildStationTip(world: World, p: ProjectedLocation): Omit<HoverTip, "px" | "py"> {
  const counts = stationCounts(world, p.loc.id);
  const pressure = stationPressure(world, p.loc);
  const faction = factionLabel(world, p.loc.traits.faction);
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
  danger: LaneDanger | undefined,
): Omit<HoverTip, "px" | "py"> {
  const rows: HoverTipRow[] = [
    { label: "distance", value: `${dist.toFixed(0)}u` },
    { label: "traffic", value: traffic ? `${traffic.count} ship${traffic.count === 1 ? "" : "s"}` : "none", tone: traffic && traffic.count > 0 ? "good" : undefined },
  ];
  if (danger && danger.count > 0) {
    rows.push({
      label: "danger",
      value: `${danger.count} encounter${danger.count === 1 ? "" : "s"} recently`,
      tone: "bad",
    });
  }
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

// Reputation → colour ramp used by the logistics tab. 0 reads as a
// cool neutral grey (no relationship yet, neither hostile nor warm),
// 1 as the trusted sage that matches the desaturated syndicate
// palette. Linear RGB interpolation between the two so the midpoint
// is a quiet green-grey.
const REP_COLOR_STOPS: { t: number; rgb: [number, number, number] }[] = [
  { t: 0.0, rgb: [0x6b, 0x74, 0x80] },
  { t: 1.0, rgb: [0x54, 0x94, 0x5b] },
];
function repColor(rep: number): string {
  const t = Math.max(0, Math.min(1, rep));
  let lo = REP_COLOR_STOPS[0];
  let hi = REP_COLOR_STOPS[REP_COLOR_STOPS.length - 1];
  for (let i = 0; i < REP_COLOR_STOPS.length - 1; i++) {
    if (t >= REP_COLOR_STOPS[i].t && t <= REP_COLOR_STOPS[i + 1].t) {
      lo = REP_COLOR_STOPS[i];
      hi = REP_COLOR_STOPS[i + 1];
      break;
    }
  }
  const span = hi.t - lo.t;
  const k = span === 0 ? 0 : (t - lo.t) / span;
  const r = Math.round(lo.rgb[0] + (hi.rgb[0] - lo.rgb[0]) * k);
  const g = Math.round(lo.rgb[1] + (hi.rgb[1] - lo.rgb[1]) * k);
  const b = Math.round(lo.rgb[2] + (hi.rgb[2] - lo.rgb[2]) * k);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// Build a marker per ship — idle ships sit in a small grid offset from
// their station along the largest empty angular wedge (the direction
// with no lanes leaving the station), and transit ships are
// interpolated along the lane from origin to destination using `(1 -
// ticksRemaining/total)`. The map smooths transit positions further
// each animation frame.
function buildShipMarkers(
  world: World,
  projectedById: Map<LocationId, ProjectedLocation>,
  links: AtlasLink[],
): ShipMarker[] {
  const playerIds = new Set(world.player?.shipIds ?? []);
  const out: ShipMarker[] = [];
  // Group idle ships by station. Order them so the player ship docks
  // at the front of the grid — readability win.
  const idleByStation = new Map<LocationId, Trader[]>();
  for (const t of Object.values(world.traders)) {
    if (t.state !== "idle") continue;
    const list = idleByStation.get(t.location) ?? [];
    list.push(t);
    idleByStation.set(t.location, list);
  }
  for (const [, list] of idleByStation) {
    list.sort((a, b) => {
      const ap = playerIds.has(a.id) ? 0 : 1;
      const bp = playerIds.has(b.id) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return a.id.localeCompare(b.id);
    });
  }

  // Per-station neighbour list from the lane network — used to
  // compute the largest empty wedge for the dock grid.
  const neighbours = new Map<LocationId, LocationId[]>();
  for (const link of links) {
    const a = neighbours.get(link.a) ?? [];
    a.push(link.b);
    neighbours.set(link.a, a);
    const b = neighbours.get(link.b) ?? [];
    b.push(link.a);
    neighbours.set(link.b, b);
  }

  for (const t of Object.values(world.traders)) {
    if (t.state === "transit" && t.destination) {
      const a = projectedById.get(t.location);
      const b = projectedById.get(t.destination);
      if (!a || !b) continue;
      const dist = routeDistance(world, t.location, t.destination);
      const tripTotal = dist != null && t.speed > 0 ? Math.max(1, Math.ceil(dist / t.speed)) : Math.max(1, t.ticksRemaining);
      const progress = Math.max(0, Math.min(1, 1 - t.ticksRemaining / tripTotal));
      out.push({
        id: t.id,
        trader: t,
        x: a.x + (b.x - a.x) * progress,
        y: a.y + (b.y - a.y) * progress,
        origin: t.location,
        destination: t.destination,
        isPlayer: playerIds.has(t.id),
        isTransit: true,
        tripTotal,
        ticksRemaining: t.ticksRemaining,
      });
      continue;
    }
    const station = projectedById.get(t.location);
    if (!station) continue;
    const list = idleByStation.get(t.location) ?? [];
    const idx = list.indexOf(t);
    const totalIdle = list.length;
    const dockNeighbours = neighbours.get(t.location) ?? [];
    const dockBisector = emptyWedgeBisector(station, dockNeighbours, projectedById);
    const dockPos = dockGridSlot(station, idx, totalIdle, dockBisector);
    out.push({
      id: t.id,
      trader: t,
      x: dockPos.x,
      y: dockPos.y,
      origin: t.location,
      destination: null,
      isPlayer: playerIds.has(t.id),
      isTransit: false,
    });
  }
  return out;
}

// Pick a "dock direction" for a station — the angle (radians) that
// bisects the largest empty wedge between connected neighbours. If a
// station has no lane connections, drop ships down-right by default.
function emptyWedgeBisector(
  station: ProjectedLocation,
  neighbourIds: LocationId[],
  projectedById: Map<LocationId, ProjectedLocation>,
): number {
  const angles = neighbourIds
    .map(id => projectedById.get(id))
    .filter((p): p is ProjectedLocation => Boolean(p))
    .map(p => Math.atan2(p.y - station.y, p.x - station.x))
    .sort((a, b) => a - b);
  if (angles.length === 0) return Math.PI / 4;
  let bestStart = angles[0];
  let bestSize = 0;
  for (let i = 0; i < angles.length; i++) {
    const next = i === angles.length - 1 ? angles[0] + Math.PI * 2 : angles[i + 1];
    const size = next - angles[i];
    if (size > bestSize) {
      bestSize = size;
      bestStart = angles[i];
    }
  }
  return bestStart + bestSize / 2;
}

// Place an idle ship in a small grid offset from the station along
// the dock bisector. Grid is 4 columns wide; rows grow as needed.
// The first row sits clear of the station's halo so the ships read
// as "parked at the station" rather than overlapping the marker.
function dockGridSlot(
  station: ProjectedLocation,
  idx: number,
  totalIdle: number,
  bisector: number,
): { x: number; y: number } {
  const cellSize = 6;
  const cols = Math.min(4, Math.max(1, totalIdle));
  const col = idx % cols;
  const row = Math.floor(idx / cols);
  const ux = Math.cos(bisector);
  const uy = Math.sin(bisector);
  const px = -uy;
  const py = ux;
  const startOffset = station.r + 7;
  const along = startOffset + row * cellSize;
  const across = (col - (cols - 1) / 2) * cellSize;
  return {
    x: station.x + ux * along + px * across,
    y: station.y + uy * along + py * across,
  };
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

function buildLaneDanger(world: World): Map<string, LaneDanger> {
  const map = new Map<string, LaneDanger>();
  const since = world.tick - LANE_DANGER_WINDOW_TICKS;
  for (const enc of world.encounterHistory ?? []) {
    if (enc.spawnedAt < since) continue;
    const key = laneKey(enc.fromLocation, enc.toLocation);
    const cur = map.get(key) ?? { count: 0 };
    cur.count += 1;
    map.set(key, cur);
  }
  return map;
}

// Recent encounters as positioned ping markers. Position is the midpoint
// of the from→to lane in projected coordinates — close enough for "this
// general corridor" without needing per-encounter geometry. Caller skips
// pings whose endpoints aren't projected (off-screen filters etc.).
function buildEncounterPings(
  world: World,
  projectedById: Map<LocationId, ProjectedLocation>,
): EncounterPing[] {
  const pings: EncounterPing[] = [];
  const cutoff = world.tick - ENCOUNTER_PING_TICKS;
  for (const enc of world.encounterHistory ?? []) {
    if (enc.spawnedAt <= cutoff) continue;
    const a = projectedById.get(enc.fromLocation);
    const b = projectedById.get(enc.toLocation);
    if (!a || !b) continue;
    pings.push({
      id: enc.id,
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
      age: world.tick - enc.spawnedAt,
    });
  }
  return pings;
}

// Systems sheet — exchange + logistics signals side by side. Class and
// focus columns dropped; replaced with equity Δ% and treasury health from
// the exchange, plus crew offers and upgrade-good counts from station
// logistics. Pressure remains as the trade-side market-stock summary.
function SystemsTable(props: {
  rows: StationSheetRow[];
  world: World;
  selectedId: LocationId | null;
  onSelect: (id: LocationId) => void;
  onHoverStation: (id: LocationId | null) => void;
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
                  onMouseEnter={() => props.onHoverStation(row.loc.id)}
                  onMouseLeave={() => props.onHoverStation(null)}
                >
                  <td>
                    <span className="atlas-station-cell">
                      <span className={`atlas-kind-dot atlas-kind-${row.kind}`} />
                      <span>
                        <span className="atlas-station-name">{row.loc.name}</span>
                        <span className="atlas-station-sub dim">{factionLabel(props.world, row.loc.traits.faction)}</span>
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
  onHoverStation: (id: LocationId | null) => void;
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
                  onMouseEnter={() => props.onHoverStation(t.state === "transit" && t.destination ? t.destination : t.location)}
                  onMouseLeave={() => props.onHoverStation(null)}
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
  // Glance preview only — last 100 samples; equity.history is unbounded.
  const sparkPoints = (exchange.equity?.history ?? []).slice(-100).map(h => h.price);
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
          {loc.traits.faction && (() => {
            const synd = world.syndicates[loc.traits.faction];
            const accent = synd?.accentHex;
            return (
              <span
                className="atlas-tag faction"
                style={accent ? { borderColor: accent, color: accent } as CSSProperties : undefined}
              >
                {synd?.name ?? loc.traits.faction}
              </span>
            );
          })()}
          {loc.traits.tags.map(tag => <span key={tag} className="atlas-tag">{tag}</span>)}
        </div>

        <ControlShareBar world={world} locId={loc.id} />

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
  const selectedTraderId = useStore(s => s.selectedTrader);
  const [openId, setOpenId] = useState<string | null>(null);
  const [buyTargetId, setBuyTargetId] = useState<string | null>(null);

  const playerShipIds = world.player?.shipIds ?? [];
  // The "buying ship" is the picker selection if it's a player ship
  // docked here, otherwise the first player ship docked here. If no
  // player ship is at the shipyard, the Buy button is disabled.
  const dockedHere = playerShipIds
    .map(id => world.traders[id])
    .filter((t): t is Trader => Boolean(t) && t.state === "idle" && t.location === loc.id);
  const preferred = selectedTraderId ? dockedHere.find(t => t.id === selectedTraderId) : undefined;
  const buyer: Trader | null = preferred ?? dockedHere[0] ?? null;

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
            {blueprints.map(bp => (
              <ShipyardBlueprintRow
                key={bp.id}
                world={world}
                bp={bp}
                buyer={buyer}
                isOpen={openId === bp.id}
                onToggle={() => setOpenId(openId === bp.id ? null : bp.id)}
                onPurchase={() => setBuyTargetId(bp.id)}
              />
            ))}
          </div>
        </>
      )}
      <BuyShipModal
        open={buyTargetId !== null}
        blueprint={buyTargetId ? blueprints.find(bp => bp.id === buyTargetId) ?? null : null}
        buyer={buyer}
        onClose={() => setBuyTargetId(null)}
      />
    </section>
  );
}

// Per-blueprint row. Owns its own ship-art lookup so the AI image is
// available collapsed (visible as a thin strip behind the summary) and
// expanded (visible as the body's splash). The cache in
// /api/ship-art/for-ship dedupes by blueprint poolKey, so repeated
// renders don't re-generate.
function ShipyardBlueprintRow({
  world,
  bp,
  buyer,
  isOpen,
  onToggle,
  onPurchase,
}: {
  world: World;
  bp: ShipBlueprint;
  buyer: Trader | null;
  isOpen: boolean;
  onToggle: () => void;
  onPurchase: () => void;
}) {
  const art = useBlueprintArtImageUrl(bp);
  const canAfford = buyer ? buyer.funds >= bp.price : false;
  const blockedReason = !buyer
    ? "Dock one of your ships at this shipyard to buy."
    : !canAfford
      ? `${buyer.name} needs Ç${bp.price.toLocaleString()}, has Ç${Math.floor(buyer.funds).toLocaleString()}.`
      : "";
  return (
    <div
      className={`atlas-shipyard-item ${isOpen ? "open" : ""} ${art.imageUrl ? "has-art" : ""}`}
      style={art.imageUrl ? artCardStyle(art.imageUrl) : undefined}
    >
      <button
        type="button"
        className="atlas-shipyard-summary"
        onClick={onToggle}
      >
        <span className={`atlas-shipyard-class atlas-shipyard-class-${bp.class}`}>{bp.classLabel}</span>
        <span className="atlas-shipyard-name">{bp.name}</span>
        <span className="atlas-shipyard-price mono">{fmtCredits(bp.price)}</span>
      </button>
      {isOpen && (
        <div className={`atlas-shipyard-body ${art.imageUrl ? "has-art" : ""}`}>
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
                onPurchase();
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
        className={`atlas-travel-btn ${disabled ? "disabled" : ""}`}
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
          {atDest ? "Docked here" : inboundHere ? "Inbound" : "Travel"}
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
  if (tags.includes("syndicate-outpost")) return "outpost";
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
    case "outpost": return "Outpost";
    default: return "Station";
  }
}

function stationSort(a: LocationDef, b: LocationDef): number {
  const rank: Record<StationKind, number> = { outpost: 0, hub: 1, research: 2, shipyard: 3, mining: 4, agri: 5, frontier: 6, station: 7 };
  return rank[stationKind(a)] - rank[stationKind(b)]
    || b.traits.techLevel - a.traits.techLevel
    || b.population - a.population
    || a.name.localeCompare(b.name);
}

function formatPopulation(population: number): string {
  return population >= 1000 ? `${(population / 1000).toFixed(1)}k` : population.toLocaleString();
}
