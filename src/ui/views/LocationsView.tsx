import { useStore } from "../store";
import { netProductionRate } from "../../sim/locations";
import "./LocationsView.css";

export function LocationsView() {
  const world = useStore((s) => s.world);
  useStore((s) => s.tickEpoch);

  const locations = Object.values(world.locations);

  return (
    <section>
      <h2>Locations — {locations.length} stations</h2>
      <div className="locations-grid">
        {locations.map((loc) => (
          <article key={loc.id} className="location-card">
            <header>
              <h3>{loc.name}</h3>
              <div className="loc-tags">
                {loc.traits.tags.map((t) => (
                  <span key={t} className="loc-tag">{t}</span>
                ))}
              </div>
            </header>
            <div className="loc-meta dim mono">
              tech {loc.traits.techLevel} · pop {loc.population.toLocaleString()} · ({loc.position.x.toFixed(1)}, {loc.position.y.toFixed(1)})
              {loc.traits.faction && <> · <span className="dim">{loc.traits.faction}</span></>}
            </div>
            <div className="loc-flow">
              <div>
                <h4>Exports</h4>
                <ul>
                  {loc.primaryExports.map((g) => (
                    <li key={g} className="mono">
                      <span>{g}</span>
                      <span className="faint">+{netProductionRate(loc, g).toFixed(1)}/t</span>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h4>Imports</h4>
                <ul>
                  {loc.primaryImports.map((g) => (
                    <li key={g} className="mono">
                      <span>{g}</span>
                      <span className="faint">{netProductionRate(loc, g).toFixed(1)}/t</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
