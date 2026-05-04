import { useStore } from "../store";
import { Modal } from "./Modal";
import { autopilotPolicy } from "../../sim/combat/encounters";
import type { EncounterChoice, EncounterLoss, OddsBand, World } from "../../sim/types";
import "./EncounterModal.css";

const ODDS_LABEL: Record<OddsBand, string> = {
  very_likely: "very likely",
  likely: "likely",
  even: "even",
  risky: "risky",
  longshot: "longshot",
};

function crewLevelLabel(level: number): string {
  if (level >= 0.7) return "veterans";
  if (level >= 0.4) return "regulars";
  return "green";
}

function lossSummary(world: World, loss: EncounterLoss): string {
  const parts: string[] = [];
  for (const c of loss.cargo) {
    parts.push(`${c.qty} ${world.goods[c.good]?.name ?? c.good}`);
  }
  if (loss.credits > 0) parts.push(`Ç${Math.round(loss.credits).toLocaleString()}`);
  if (loss.hull > 0) parts.push(`${loss.hull} hull`);
  return parts.length > 0 ? parts.join(", ") : "—";
}

export function EncounterModal() {
  const encounter = useStore(s => s.world.pendingEncounter);
  const world = useStore(s => s.world);
  const resolve = useStore(s => s.resolveEncounter);
  if (!encounter) return null;
  const ship = world.traders[encounter.shipId];
  if (!ship) return null;

  const merc = ship.crew?.mercenary;
  const fromLoc = world.locations[encounter.fromLocation]?.name ?? encounter.fromLocation;
  const toLoc = world.locations[encounter.toLocation]?.name ?? encounter.toLocation;
  const recommended = autopilotPolicy(ship, encounter);

  const partialLossText = (() => {
    if (encounter.attacker.kind === "rival_syndicate") {
      return `Ç${encounter.negotiateBribe.toLocaleString()} bribe`;
    }
    const cargoText = encounter.negotiatePartialCargo
      .map(c => `${c.qty} ${world.goods[c.good]?.name ?? c.good}`)
      .join(", ");
    if (!cargoText) return `Ç${encounter.negotiateBribe.toLocaleString()} bribe`;
    return `Ç${encounter.negotiateBribe.toLocaleString()} + ${cargoText}`;
  })();

  const cantBribe = ship.funds < encounter.negotiateBribe;

  return (
    <Modal
      open
      onClose={() => {}}
      closeOnBackdrop={false}
      eyebrow={`Tick ${world.tick} • ${fromLoc} → ${toLoc}`}
      title={`${encounter.attacker.name} intercepts your route`}
      dialogClassName="encounter-dialog"
    >
      <div className="encounter-grid">
        <section className="encounter-stats">
          <div className="encounter-stats-col">
            <header className="encounter-stats-head">YOU</header>
            <Stat label="Weapons" value={ship.weaponPower ?? 0} />
            <Stat label="Hull" value={ship.hull ?? 0} />
            <Stat label="Speed" value={ship.speed} />
            <Stat label="Mercenary" value={merc ? `tier ${merc.tier}` : "—"} muted={!merc} />
          </div>
          <div className="encounter-stats-col">
            <header className="encounter-stats-head">{encounter.attacker.name}</header>
            <Stat label="Weapons" value={encounter.attacker.weaponPower} />
            <Stat label="Hull" value={encounter.attacker.hull} />
            <Stat label="Speed" value={encounter.attacker.speed} />
            <Stat label="Crew" value={crewLevelLabel(encounter.attacker.crewLevel)} />
          </div>
        </section>

        <section className="encounter-actions">
          <ActionCard
            label="Fight"
            band={encounter.oddsFight}
            risk={`risk ${lossSummary(world, encounter.fightLossOnFail)}`}
            recommended={recommended === "fight"}
            onClick={() => resolve("fight")}
          />
          <ActionCard
            label="Flee"
            band={encounter.oddsFlee}
            risk={`risk ${lossSummary(world, encounter.fleeLossOnFail)}`}
            recommended={recommended === "flee"}
            onClick={() => resolve("flee")}
          />
          <ActionCard
            label={encounter.attacker.kind === "pirate" ? "Bribe" : "Negotiate"}
            band={encounter.oddsNegotiate}
            risk={cantBribe ? "insufficient funds" : partialLossText}
            recommended={recommended === "negotiate"}
            disabled={cantBribe}
            onClick={() => resolve("negotiate")}
          />
        </section>
      </div>
    </Modal>
  );
}

function Stat({ label, value, muted }: { label: string; value: number | string; muted?: boolean }) {
  return (
    <div className={`encounter-stat ${muted ? "muted" : ""}`}>
      <span className="encounter-stat-label">{label}</span>
      <span className="encounter-stat-value">{value}</span>
    </div>
  );
}

function ActionCard(props: {
  label: string;
  band: OddsBand;
  risk: string;
  recommended?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { label, band, risk, recommended, disabled, onClick } = props;
  return (
    <button
      type="button"
      className={`encounter-action band-${band} ${recommended ? "recommended" : ""}`}
      onClick={onClick}
      disabled={disabled}
    >
      <span className="encounter-action-head">
        <span className="encounter-action-label">{label}</span>
        {recommended && <span className="encounter-action-tag">recommended</span>}
      </span>
      <span className="encounter-action-band">{ODDS_LABEL[band]}</span>
      <span className="encounter-action-risk">{risk}</span>
    </button>
  );
}

// Re-export for type-checker friendliness when the modal is referenced
// from other files that need the choice type.
export type { EncounterChoice };
