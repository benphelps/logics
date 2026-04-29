import { useMemo, type CSSProperties, type ReactNode } from "react";
import type { IconType } from "react-icons";
import {
  GiCargoCrate,
  GiFactory,
  GiHabitatDome,
  GiPathDistance,
} from "react-icons/gi";
import { useStore } from "../store";
import { reachableNeighbors, routeSegments } from "../../sim/geometry";
import { netProductionRate } from "../../sim/locations";
import type { LocationDef, LocationId, World } from "../../sim/types";
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
  useStore((s) => s.tickEpoch);

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
  const selectedMarket = selected ? marketRows(world, selected).slice(0, 9) : [];
  const selectedCounts = selected ? stationCounts(world, selected.id) : { docked: 0, inbound: 0, jobs: 0, routes: 0 };

  return (
    <section className="atlas-view">
      <div className="atlas-grid">
        <section className="atlas-sheet-panel">
          <div className="atlas-panel-head art-panel-head" style={artCardStyle(headerArtUrl("atlasStations"))}>
            <div>
              <span className="atlas-panel-label">Stations</span>
              <span className="dim">{locations.length} known ports, sorted by route pressure</span>
            </div>
            <div className="atlas-sheet-legend">
              <span><span className="atlas-pressure-dot short" /> shortages</span>
              <span><span className="atlas-pressure-dot surplus" /> surplus</span>
            </div>
          </div>

          <div className="atlas-table-scroll">
            <table className="atlas-station-table">
              <colgroup>
                <col className="col-station" />
                <col className="col-kind" />
                <col className="col-profile" />
                <col className="col-traffic" />
                <col className="col-flow" />
                <col className="col-flow" />
                <col className="col-pressure" />
              </colgroup>
              <thead>
                <tr>
                  <th>Station</th>
                  <th>Class</th>
                  <th>Profile</th>
                  <th>Traffic</th>
                  <th>Exports</th>
                  <th>Imports</th>
                  <th>Pressure</th>
                </tr>
              </thead>
              <tbody>
                {sheetRows.map(row => {
                  const selectedRow = selected?.id === row.loc.id;
                  return (
                    <tr
                      key={row.loc.id}
                      className={selectedRow ? "active" : ""}
                      onClick={() => selectLocation(row.loc.id)}
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
                      <td>
                        <span className="atlas-stack">
                          <span className="mono">L{row.loc.traits.techLevel}</span>
                          <span className="mono dim">{formatPopulation(row.loc.population)}</span>
                        </span>
                      </td>
                      <td>
                        <span className="atlas-stack">
                          <span className="mono">{row.counts.routes} routes</span>
                          <span className="mono dim">{row.counts.docked}+{row.counts.inbound} ships · {row.counts.jobs} jobs</span>
                        </span>
                      </td>
                      <td><FlowText world={world} loc={row.loc} goods={row.loc.primaryExports} /></td>
                      <td><FlowText world={world} loc={row.loc} goods={row.loc.primaryImports} /></td>
                      <td>
                        <span className={`atlas-pressure ${row.pressure.tone}`}>
                          <span className="mono">{row.pressure.short} short</span>
                          <span className="mono">{row.pressure.surplus} surplus</span>
                          <span>{row.pressure.focusGood}</span>
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
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
              projected={projected}
              projectedById={projectedById}
              links={links}
              selectedId={selected?.id ?? null}
              playerLocation={playerShip?.location ?? null}
              playerDestination={playerShip?.state === "transit" ? playerShip.destination : null}
              onSelect={selectLocation}
            />
          </section>

          <section
            className={`atlas-detail-panel ${selected ? "atlas-info-card" : ""}`}
            style={selected ? artCardStyle(stationArtUrl(selected)) : undefined}
          >
            {selected && (
              <>
                <div className="atlas-detail-head">
                  <div>
                    <span className="atlas-panel-label">Selected Port</span>
                    <h3>{selected.name}</h3>
                  </div>
                  <span className={`atlas-kind atlas-kind-${stationKind(selected)}`}>{kindLabel(stationKind(selected))}</span>
                </div>
                <div className="atlas-tags">
                  {selected.traits.faction && <span className="atlas-tag faction">{selected.traits.faction}</span>}
                  {selected.traits.tags.map(tag => <span key={tag} className="atlas-tag">{tag}</span>)}
                </div>
                <div className="atlas-stat-grid">
                  <AtlasSummary icon={GiFactory} label="Tech" value={`L${selected.traits.techLevel}`} />
                  <AtlasSummary icon={GiHabitatDome} label="Pop" value={formatPopulation(selected.population)} />
                  <AtlasSummary icon={GiPathDistance} label="Routes" value={selectedCounts.routes.toString()} />
                  <AtlasSummary icon={GiPathDistance} label="Inbound" value={selectedCounts.inbound.toString()} />
                </div>
                <div className="atlas-coords mono dim">
                  x {selected.position.x.toFixed(1)} / y {selected.position.y.toFixed(1)} / open contracts {selectedCounts.jobs}
                </div>

                <div className="atlas-section">
                  <div className="atlas-section-title">Market Pressure</div>
                  <div className="atlas-market-list">
                    {selectedMarket.map(row => (
                      <div key={row.good} className={`atlas-market-row ${row.tone}`}>
                        <span className="atlas-market-good">{row.name}</span>
                        <span className="mono">{row.stock.toFixed(0)} / {row.target.toFixed(0)}</span>
                        <span className="mono">Ç{row.price.toFixed(1)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            )}
          </section>
        </aside>
      </div>
    </section>
  );
}

function artCardStyle(url: string): CSSProperties {
  return { "--card-art": `url("${url}")` } as CSSProperties;
}

function SectorMap({ projected, projectedById, links, selectedId, playerLocation, playerDestination, onSelect }: {
  projected: ProjectedLocation[];
  projectedById: Map<LocationId, ProjectedLocation>;
  links: AtlasLink[];
  selectedId: LocationId | null;
  playerLocation: LocationId | null;
  playerDestination: LocationId | null;
  onSelect: (id: LocationId) => void;
}) {
  return (
    <svg className="atlas-map" viewBox={`0 0 ${MAP_W} ${MAP_H}`} role="img" aria-label="Station map">
      <defs>
        <radialGradient id="atlasGlow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.35)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>
      <rect className="atlas-map-bg" x="0" y="0" width={MAP_W} height={MAP_H} rx="0" />
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
          return <line key={`${link.a}-${link.b}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
        })}
      </g>
      {playerLocation && playerDestination && (
        <TransitTrace shipLocation={playerLocation} destination={playerDestination} projectedById={projectedById} />
      )}
      <g className="atlas-nodes">
        {projected.map(p => (
          <g
            key={p.loc.id}
            className={`atlas-node atlas-node-${p.kind} ${selectedId === p.loc.id ? "selected" : ""}`}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(p.loc.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelect(p.loc.id);
              }
            }}
          >
            <title>{p.loc.name}</title>
            <circle className="atlas-node-glow" cx={p.x} cy={p.y} r={p.r * 3.4} />
            <circle className="atlas-node-core" cx={p.x} cy={p.y} r={p.r} />
            {selectedId === p.loc.id && <circle className="atlas-node-ring" cx={p.x} cy={p.y} r={p.r + 9} />}
          </g>
        ))}
      </g>
      {playerLocation && projectedById.get(playerLocation) && (
        <PlayerMarker p={projectedById.get(playerLocation)!} />
      )}
    </svg>
  );
}

function TransitTrace({ shipLocation, destination, projectedById }: {
  shipLocation: LocationId; destination: LocationId; projectedById: Map<LocationId, ProjectedLocation>;
}) {
  const a = projectedById.get(shipLocation);
  const b = projectedById.get(destination);
  if (!a || !b) return null;
  return (
    <g className="atlas-player-route">
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
    </g>
  );
}

function PlayerMarker({ p }: { p: ProjectedLocation }) {
  const size = 10;
  const d = `M ${p.x} ${p.y - size} L ${p.x + size} ${p.y} L ${p.x} ${p.y + size} L ${p.x - size} ${p.y} Z`;
  return <path className="atlas-player-marker" d={d}><title>Player ship</title></path>;
}

function AtlasSummary({ icon: Icon, label, value }: { icon: IconType; label: string; value: ReactNode }) {
  return (
    <span className="atlas-summary-item">
      <Icon className="atlas-icon" aria-hidden="true" focusable="false" />
      <span>
        <span className="atlas-summary-label">{label}</span>
        <span className="atlas-summary-value">{value}</span>
      </span>
    </span>
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
  return {
    short: shortRows.length,
    surplus: surplusRows.length,
    focusGood: focus?.name ?? "balanced",
    tone: shortRows.length > 0 ? "short" : surplusRows.length > 0 ? "surplus" : "",
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
