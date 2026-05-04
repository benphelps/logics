import type { CSSProperties } from "react";
import { useStore } from "../store";
import { Modal } from "./Modal";
import { autopilotPolicy } from "../../sim/combat/encounters";
import { SHIP_ART, shipArtUrl } from "../art";
import type { EncounterChoice, EncounterKind, EncounterLoss, OddsBand, World } from "../../sim/types";
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

interface LossPill {
  id: string;
  text: string;
}

function lossPills(world: World, loss: EncounterLoss): LossPill[] {
  const pills: LossPill[] = [];
  for (const c of loss.cargo) {
    pills.push({ id: `c-${c.good}`, text: `${c.qty} ${world.goods[c.good]?.name ?? c.good}` });
  }
  if (loss.credits > 0) pills.push({ id: "credits", text: `Ç${Math.round(loss.credits).toLocaleString()}` });
  if (loss.hull > 0) pills.push({ id: "hull", text: `${loss.hull} hull` });
  return pills;
}

function attackerArtUrl(kind: EncounterKind): string {
  // No bespoke pirate / rival art yet — both reuse the scout silhouette,
  // which reads as a small combat ship.
  void kind;
  return SHIP_ART.scout;
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

  const negotiatePills: LossPill[] = (() => {
    const pills: LossPill[] = [
      { id: "bribe", text: `Ç${encounter.negotiateBribe.toLocaleString()}` },
    ];
    if (encounter.attacker.kind !== "rival_syndicate") {
      for (const c of encounter.negotiatePartialCargo) {
        pills.push({ id: `np-${c.good}`, text: `${c.qty} ${world.goods[c.good]?.name ?? c.good}` });
      }
    }
    return pills;
  })();

  const playerArt = shipArtUrl(ship);
  const enemyArt = attackerArtUrl(encounter.attacker.kind);

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
          <article
            className="encounter-stats-col art-card"
            style={{ "--card-art": `url("${playerArt}")` } as CSSProperties}
          >
            <header className="encounter-stats-head">{ship.name}</header>
            <Stat label="Weapons" value={ship.weaponPower ?? 0} />
            <Stat label="Hull" value={ship.hull ?? 0} />
            <Stat label="Speed" value={ship.speed} />
            <Stat label="Mercenary" value={merc ? `tier ${merc.tier}` : "—"} muted={!merc} />
          </article>
          <article
            className="encounter-stats-col art-card enemy"
            style={{ "--card-art": `url("${enemyArt}")` } as CSSProperties}
          >
            <header className="encounter-stats-head">{encounter.attacker.name}</header>
            <Stat label="Weapons" value={encounter.attacker.weaponPower} />
            <Stat label="Hull" value={encounter.attacker.hull} />
            <Stat label="Speed" value={encounter.attacker.speed} />
            <Stat label="Crew" value={crewLevelLabel(encounter.attacker.crewLevel)} />
          </article>
        </section>

        <section className="encounter-actions">
          <ActionCard
            label="Fight"
            band={encounter.oddsFight}
            pills={lossPills(world, encounter.fightLossOnFail)}
            recommended={recommended === "fight"}
            onClick={() => resolve("fight")}
          />
          <ActionCard
            label="Flee"
            band={encounter.oddsFlee}
            pills={lossPills(world, encounter.fleeLossOnFail)}
            recommended={recommended === "flee"}
            onClick={() => resolve("flee")}
          />
          <ActionCard
            label={encounter.attacker.kind === "pirate" ? "Bribe" : "Negotiate"}
            band={encounter.oddsNegotiate}
            pills={negotiatePills}
            note={cantBribe ? "insufficient funds" : undefined}
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
  pills: LossPill[];
  note?: string;
  recommended?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { label, band, pills, note, recommended, disabled, onClick } = props;
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
      {note ? (
        <span className="encounter-action-note">{note}</span>
      ) : (
        <span className="encounter-action-pills">
          {pills.map(p => (
            <span key={p.id} className="encounter-action-pill">
              <span className="encounter-action-pill-sign" aria-hidden="true">−</span>
              <span className="encounter-action-pill-text">{p.text}</span>
            </span>
          ))}
        </span>
      )}
    </button>
  );
}

// Re-export for type-checker friendliness when the modal is referenced
// from other files that need the choice type.
export type { EncounterChoice };
