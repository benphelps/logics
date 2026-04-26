import { useStore } from "../store";
import "./ShipsView.css";

export function ShipsView() {
  const world = useStore((s) => s.world);
  useStore((s) => s.tickEpoch);

  const traders = Object.values(world.traders);

  return (
    <section>
      <h2>Ships — {traders.length} active</h2>
      <div className="ships-scroll">
        <table className="ships">
          <thead>
            <tr>
              <th>Name</th>
              <th>Class</th>
              <th>Location</th>
              <th>State</th>
              <th>Destination</th>
              <th className="numeric">Cap</th>
              <th>Cargo</th>
              <th>Fuel</th>
              <th className="numeric">Funds</th>
            </tr>
          </thead>
          <tbody>
            {traders.map((t) => {
              const fuel = t.currentFuel;
              const fuelPct = fuel ? (fuel.qty / t.fuelCapacity) * 100 : 0;
              const fuelTone = fuelPct < 25 ? "bad" : fuelPct < 50 ? "warn" : "";
              const fundsTone = t.funds < 1000 ? "bad" : t.funds < 5000 ? "warn" : "";
              const stateTone =
                t.state === "transit" ? "good" :
                t.funds === 0 ? "bad" :
                "dim";
              const klass = inferShipClass(t);

              return (
                <tr key={t.id}>
                  <td className="rowhead">{t.name}</td>
                  <td className="dim" style={{ textTransform: "capitalize" }}>{klass}</td>
                  <td>{world.locations[t.location]?.name ?? t.location}</td>
                  <td className={stateTone}>{t.state}</td>
                  <td className="dim">{t.destination ? (world.locations[t.destination]?.name ?? t.destination) : "—"}</td>
                  <td className="numeric mono">{t.capacity}</td>
                  <td className="mono">
                    {t.cargo
                      ? <span><span className="dim">{t.cargo.good}×</span>{t.cargo.qty}</span>
                      : <span className="faint">—</span>}
                  </td>
                  <td className="mono">
                    {fuel
                      ? <span><span className="dim">{fuel.good}</span> <span className={fuelTone}>{fuel.qty.toFixed(0)}/{t.fuelCapacity}</span></span>
                      : <span className="bad">empty</span>}
                  </td>
                  <td className={`numeric mono ${fundsTone}`}>Ç{Math.round(t.funds).toLocaleString()}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function inferShipClass(t: { fuelTypes: { good: string }[]; speed: number; capacity: number }): string {
  if (t.fuelTypes.length > 1) return "antimatter hybrid";
  if (t.speed >= 2) return "fast scout";
  return "basic hauler";
}
