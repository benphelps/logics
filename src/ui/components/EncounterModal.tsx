import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useStore } from "../store";
import { Modal } from "./Modal";
import { autopilotPolicy } from "../../sim/combat/encounters";
import { encounterLogMessage, encounterLogTone } from "../../sim/combat/log";
import { SHIP_ART, shipArtUrl } from "../art";
import type {
  Encounter,
  EncounterChoice,
  EncounterKind,
  EncounterLoss,
  EncounterOutcome,
  OddsBand,
  ShipLogTone,
  World,
} from "../../sim/types";
import "./EncounterModal.css";

const ODDS_LABEL: Record<OddsBand, string> = {
  very_likely: "very likely",
  likely: "likely",
  even: "even",
  risky: "risky",
  longshot: "longshot",
};

// How long the rolling animation runs before the result reveals. Long enough
// to feel like a real beat, short enough that it never interrupts the flow.
const ROLL_DURATION_MS = 1200;

const OUTCOME_LABEL: Record<EncounterOutcome, string> = {
  won: "Victory",
  lost: "Defeated",
  escaped: "Escaped",
  fled_damaged: "Damaged escape",
  negotiated_peace: "Truce",
  negotiated_partial: "Bribe paid",
  negotiated_fail: "Doublecrossed",
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
  return sortPillsForPacking(pills);
}

function sortPillsForPacking(pills: LossPill[]): LossPill[] {
  if (pills.length <= 1) return pills;
  const sorted = [...pills].sort((a, b) => b.text.length - a.text.length);
  const out: LossPill[] = [];
  let lo = 0;
  let hi = sorted.length - 1;
  let takeLong = true;
  while (lo <= hi) {
    if (takeLong) out.push(sorted[lo++]);
    else out.push(sorted[hi--]);
    takeLong = !takeLong;
  }
  return out;
}

function attackerArtUrl(kind: EncounterKind): string {
  void kind;
  return SHIP_ART.scout;
}

type Phase = "choosing" | "rolling" | "revealed";

// Match the Modal's exit-animation duration so the cached encounter content
// is held just long enough for the fade-out to finish.
const ENCOUNTER_EXIT_MS = 200;

export function EncounterModal() {
  const encounter = useStore(s => s.world.pendingEncounter);
  const world = useStore(s => s.world);
  const resolve = useStore(s => s.resolveEncounter);
  const dismiss = useStore(s => s.dismissResolvedEncounter);

  // The phase drives the lower panel: choice cards → spinning dice → result.
  // Tied to the encounter id so a fresh spawn resets the UI cleanly even if
  // the previous one was somehow left mid-roll.
  const [phase, setPhase] = useState<Phase>("choosing");
  const [pickedChoice, setPickedChoice] = useState<EncounterChoice | null>(null);
  const rollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cache the most-recent encounter so we can keep rendering modal content
  // through the Modal component's exit animation. Without this the live
  // encounter clears the moment the user hits Continue and the Modal would
  // re-render with no body (no fade).
  const [shownEncounter, setShownEncounter] = useState<typeof encounter>(encounter);
  useEffect(() => {
    if (encounter) {
      setShownEncounter(encounter);
      return;
    }
    if (!shownEncounter) return;
    const t = setTimeout(() => setShownEncounter(undefined), ENCOUNTER_EXIT_MS);
    return () => clearTimeout(t);
  }, [encounter, shownEncounter]);

  const encounterId = encounter?.id;
  useEffect(() => {
    setPhase(encounterId && encounter?.resolution ? "revealed" : "choosing");
    setPickedChoice(encounter?.resolution?.choice ?? null);
    return () => {
      if (rollTimerRef.current) {
        clearTimeout(rollTimerRef.current);
        rollTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounterId]);

  if (!shownEncounter) return null;
  const ship = world.traders[shownEncounter.shipId];
  if (!ship) return null;
  // Use the cached encounter for rendering so content stays put during the
  // dialog's fade-out. The live `encounter` only drives the Modal's open
  // prop — flipping that to false triggers the fade.
  const renderEncounter = shownEncounter;

  const merc = ship.crew?.mercenary;
  const fromLoc = world.locations[renderEncounter.fromLocation]?.name ?? renderEncounter.fromLocation;
  const toLoc = world.locations[renderEncounter.toLocation]?.name ?? renderEncounter.toLocation;
  const recommended = autopilotPolicy(ship, renderEncounter);

  const playerArt = shipArtUrl(ship);
  const enemyArt = attackerArtUrl(renderEncounter.attacker.kind);
  const cantBribe = ship.funds < renderEncounter.negotiateBribe;

  const negotiatePills: LossPill[] = (() => {
    const pills: LossPill[] = [
      { id: "bribe", text: `Ç${renderEncounter.negotiateBribe.toLocaleString()}` },
    ];
    if (renderEncounter.attacker.kind !== "rival_syndicate") {
      for (const c of renderEncounter.negotiatePartialCargo) {
        pills.push({ id: `np-${c.good}`, text: `${c.qty} ${world.goods[c.good]?.name ?? c.good}` });
      }
    }
    return sortPillsForPacking(pills);
  })();

  const handleChoose = (choice: EncounterChoice) => {
    if (phase !== "choosing") return;
    setPickedChoice(choice);
    setPhase("rolling");
    if (rollTimerRef.current) clearTimeout(rollTimerRef.current);
    rollTimerRef.current = setTimeout(() => {
      // Stamp resolution. Modal re-renders with encounter.resolution set;
      // we flip phase immediately so the reveal animates in.
      resolve(choice);
      setPhase("revealed");
      rollTimerRef.current = null;
    }, ROLL_DURATION_MS);
  };

  const handleContinue = () => {
    dismiss();
  };

  return (
    <Modal
      open={!!encounter}
      onClose={() => {}}
      closeOnBackdrop={false}
      eyebrow={`Tick ${world.tick} • ${fromLoc} → ${toLoc}`}
      title={`${renderEncounter.attacker.name} intercepts your route`}
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
            <header className="encounter-stats-head">{renderEncounter.attacker.name}</header>
            <Stat label="Weapons" value={renderEncounter.attacker.weaponPower} />
            <Stat label="Hull" value={renderEncounter.attacker.hull} />
            <Stat label="Speed" value={renderEncounter.attacker.speed} />
            <Stat label="Crew" value={crewLevelLabel(renderEncounter.attacker.crewLevel)} />
          </article>
        </section>

        {phase === "choosing" && (
          <section className="encounter-actions">
            <ActionCard
              label="Fight"
              band={renderEncounter.oddsFight}
              pills={lossPills(world, renderEncounter.fightLossOnFail)}
              recommended={recommended === "fight"}
              onClick={() => handleChoose("fight")}
            />
            <ActionCard
              label="Flee"
              band={renderEncounter.oddsFlee}
              pills={lossPills(world, renderEncounter.fleeLossOnFail)}
              recommended={recommended === "flee"}
              onClick={() => handleChoose("flee")}
            />
            <ActionCard
              label={renderEncounter.attacker.kind === "pirate" ? "Bribe" : "Negotiate"}
              band={renderEncounter.oddsNegotiate}
              pills={negotiatePills}
              note={cantBribe ? "insufficient funds" : undefined}
              recommended={recommended === "negotiate"}
              disabled={cantBribe}
              onClick={() => handleChoose("negotiate")}
            />
          </section>
        )}

        {phase === "rolling" && pickedChoice && (
          <RollingPanel choice={pickedChoice} />
        )}

        {phase === "revealed" && renderEncounter.resolution && (
          <RevealedPanel
            world={world}
            encounter={renderEncounter}
            onContinue={handleContinue}
          />
        )}
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
        <span className="encounter-action-band">{ODDS_LABEL[band]}</span>
      </span>
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

// --- rolling phase -------------------------------------------------------

const CHOICE_LABEL: Record<EncounterChoice, string> = {
  fight: "Engaging",
  flee: "Burning hard",
  negotiate: "Hailing",
};

function RollingPanel({ choice }: { choice: EncounterChoice }) {
  return (
    <section className="encounter-roll" aria-live="polite">
      <div className="encounter-roll-dice" aria-hidden="true">
        <Die delay="0ms" />
        <Die delay="120ms" />
        <Die delay="240ms" />
      </div>
      <div className="encounter-roll-label">
        <span className="encounter-roll-action">{CHOICE_LABEL[choice]}</span>
        <span className="encounter-roll-status">Rolling<span className="encounter-roll-dots">…</span></span>
      </div>
    </section>
  );
}

function Die({ delay }: { delay: string }) {
  return (
    <span className="encounter-die" style={{ animationDelay: delay }}>
      <span className="encounter-die-pip p1" />
      <span className="encounter-die-pip p2" />
      <span className="encounter-die-pip p3" />
      <span className="encounter-die-pip p4" />
      <span className="encounter-die-pip p5" />
    </span>
  );
}

// --- revealed phase ------------------------------------------------------

function RevealedPanel(props: {
  world: World;
  encounter: Encounter;
  onContinue: () => void;
}) {
  const { world, encounter, onContinue } = props;
  const r = encounter.resolution!;
  const tone: ShipLogTone = encounterLogTone(encounter);
  const message = encounterLogMessage(world, encounter);
  const pills = r.loss ? lossPills(world, r.loss) : [];
  return (
    <section className={`encounter-reveal tone-${tone}`}>
      <div className="encounter-reveal-row encounter-reveal-head-row">
        <span className="encounter-reveal-head">
          <span className="encounter-reveal-outcome">{OUTCOME_LABEL[r.outcome]}</span>
          <span className="encounter-reveal-choice">via {choiceLabel(r.choice)}</span>
        </span>
        {pills.length > 0 ? (
          <span className="encounter-reveal-pills">
            {pills.map(p => (
              <span key={p.id} className="encounter-action-pill">
                <span className="encounter-action-pill-sign" aria-hidden="true">−</span>
                <span className="encounter-action-pill-text">{p.text}</span>
              </span>
            ))}
          </span>
        ) : (
          <span className="encounter-reveal-clean">no losses</span>
        )}
      </div>
      <p className="encounter-reveal-row encounter-reveal-message-row">{message}</p>
      <button
        type="button"
        className="encounter-action recommended encounter-reveal-continue"
        onClick={onContinue}
        autoFocus
      >
        <span className="encounter-action-head">
          <span className="encounter-action-label">Continue</span>
        </span>
      </button>
    </section>
  );
}

function choiceLabel(choice: EncounterChoice): string {
  switch (choice) {
    case "fight": return "Fight";
    case "flee": return "Flee";
    case "negotiate": return "Negotiate";
  }
}

export type { EncounterChoice };
