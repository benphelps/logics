import { useMemo } from "react";
import { useStore } from "../store";
import "./MarketsView.css";

interface Cell {
  stock: number;
  price: number;
  basePrice: number;
  target: number;
}

function priceTone(price: number, base: number): string {
  if (base <= 0) return "";
  const ratio = price / base;
  if (ratio >= 2.5) return "bad";
  if (ratio >= 1.5) return "warn";
  if (ratio <= 0.5) return "good";
  return "";
}

function stockTone(stock: number, target: number): string {
  if (target <= 0) return "faint";
  const ratio = stock / target;
  if (ratio < 0.25) return "bad";
  if (ratio < 0.75) return "warn";
  if (ratio > 2.5) return "good";
  return "";
}

export function MarketsView() {
  const world = useStore((s) => s.world);
  useStore((s) => s.tickEpoch);

  const goodIds = useMemo(() => Object.keys(world.goods), [world.goods]);
  const locationIds = useMemo(() => Object.keys(world.locations), [world.locations]);

  return (
    <section>
      <h2>Markets — stock @ price</h2>
      <div className="markets-scroll">
        <table className="markets">
          <thead>
            <tr>
              <th className="rowhead">Location</th>
              <th className="rowhead numeric">Tech</th>
              {goodIds.map((g) => (
                <th key={g} className="numeric goodcol">
                  <div className="goodname">{world.goods[g].name.split(" ").pop()}</div>
                  <div className="goodbase faint mono">Ç{world.goods[g].basePrice}</div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {locationIds.map((locId) => {
              const loc = world.locations[locId];
              const market = world.markets[locId];
              return (
                <tr key={locId}>
                  <td className="rowhead">
                    <div>{loc.name}</div>
                    <div className="faint" style={{ fontSize: 10 }}>
                      {loc.traits.tags.slice(0, 2).join(" · ")}
                    </div>
                  </td>
                  <td className="numeric mono dim">{loc.traits.techLevel}</td>
                  {goodIds.map((g) => {
                    const cell: Cell = {
                      stock: market.stock[g] ?? 0,
                      price: market.prices[g] ?? 0,
                      basePrice: world.goods[g].basePrice,
                      target: loc.targetStock[g] ?? 0,
                    };
                    const sTone = stockTone(cell.stock, cell.target);
                    const pTone = priceTone(cell.price, cell.basePrice);
                    return (
                      <td key={g} className={`numeric mono cell tone-${pTone || "neutral"}`}>
                        <div className={`stock ${sTone}`}>{cell.stock.toFixed(0)}</div>
                        <div className={`price ${pTone}`}>{cell.price.toFixed(1)}</div>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Legend />
    </section>
  );
}

function Legend() {
  return (
    <div className="markets-legend dim">
      <span><span className="swatch tone-good" /> price ≤ ½×</span>
      <span><span className="swatch tone-warn" /> price ≥ 1.5×</span>
      <span><span className="swatch tone-bad"  /> price ≥ 2.5×</span>
      <span className="faint">cells stack stock above price</span>
    </div>
  );
}
