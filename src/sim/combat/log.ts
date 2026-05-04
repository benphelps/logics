// Encounter → ship-log entry formatting. Lives in combat/ rather than log.ts
// so the core log module doesn't pull in encounter types.

import type { Encounter, ShipLogTone, World } from "../types";

export function encounterLogMessage(world: World, encounter: Encounter): string {
  const r = encounter.resolution;
  if (!r) return `Hostile contact — ${encounter.attacker.name}`;
  const goodName = (id?: string) => (id ? world.goods[id]?.name ?? id : "");
  const locName = (id?: string) => (id ? world.locations[id]?.name ?? id : "");
  const route = `near ${locName(encounter.toLocation)}`;
  const attacker = encounter.attacker.name;
  const lossSummary = (): string => {
    const loss = r.loss;
    if (!loss) return "no losses";
    const parts: string[] = [];
    if (loss.credits > 0) parts.push(`Ç${Math.round(loss.credits).toLocaleString()}`);
    for (const c of loss.cargo) parts.push(`${c.qty} ${goodName(c.good)}`);
    if (loss.hull > 0) parts.push(`${loss.hull} hull`);
    return parts.length > 0 ? parts.join(", ") : "no losses";
  };

  switch (r.outcome) {
    case "won":
      return `Drove off ${attacker} ${route}.`;
    case "lost":
      return `Boarded by ${attacker} ${route} — lost ${lossSummary()}.`;
    case "escaped":
      return `Outran ${attacker} ${route}.`;
    case "fled_damaged":
      return `Took ${r.loss?.hull ?? 0} hull from ${attacker} during escape.`;
    case "negotiated_peace":
      return `Bribed ${attacker} ${route} — paid Ç${Math.round(r.loss?.credits ?? 0).toLocaleString()}, walked clean.`;
    case "negotiated_partial":
      return `Paid off ${attacker} ${route} — ${lossSummary()}.`;
    case "negotiated_fail":
      return `Negotiation with ${attacker} ${route} collapsed — ${lossSummary()}.`;
  }
}

export function encounterLogTone(encounter: Encounter): ShipLogTone {
  const r = encounter.resolution;
  if (!r) return "warn";
  switch (r.outcome) {
    case "won": return "good";
    case "escaped": return "good";
    case "negotiated_peace": return "warn";
    case "negotiated_partial": return "warn";
    case "fled_damaged": return "warn";
    case "lost": return "bad";
    case "negotiated_fail": return "bad";
  }
}
