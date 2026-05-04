import { useEffect, useMemo, useRef, useState } from "react";
import { MdCasino, MdRefresh } from "react-icons/md";
import type { CrewAge, CrewIdentity, CrewRace, CrewSex, Syndicate, SyndicateId, World } from "../../sim/types";
import { CREW_AGES, CREW_RACES, CREW_SEXES } from "../../sim/crewIdentity";
import { SYNDICATE_TRAITS } from "../../sim/data/syndicates";
import { useStore, type NewGamePhase, type PilotDraft } from "../store";
import { useCrewHeadshot } from "../headshots";
import { randomPilotName } from "../pilotNames";
import { Modal } from "./Modal";
import "./NewGameModal.css";

// Suggestions for the clothing/vibe field. Clicking a chip drops the
// label into the input; the player can then edit freely.
const VIBE_CHIPS: readonly string[] = [
  "freighter captain coat with shoulder bars",
  "patched bomber jacket and aviator scarf",
  "tailored syndicate dress uniform",
  "rugged cargo vest and harness clips",
  "minimalist navigator coat with a soft collar",
  "neon synthweave ridged with circuit lines",
  "scavenger leathers and a worn comm earpiece",
];

// Wall-clock target for the fake portrait progress bar. The OpenAI image
// generation runs on the server side and routinely takes 12–18s; we
// animate to 95% over this duration and stall there until the headshot
// status flips to "ready", at which point we snap to 100%.
const HEADSHOT_FAKE_DURATION_MS = 15_000;

export function NewGameModal() {
  const pending = useStore(s => s.pendingNewGame);
  const advance = useStore(s => s.advanceNewGamePhase);
  const setDraft = useStore(s => s.setPilotDraft);
  const confirmNewGame = useStore(s => s.confirmNewGame);
  const cancelNewGame = useStore(s => s.cancelNewGame);

  const open = pending != null;
  const phase: NewGamePhase = pending?.phase ?? "intro";
  const intent = pending?.intent ?? "create";
  const draft = pending?.pilotDraft ?? null;

  const [pickedSyndicate, setPickedSyndicate] = useState<SyndicateId | null>(null);

  // Reset transient state when the wizard closes.
  useEffect(() => {
    if (!open) {
      setPickedSyndicate(null);
    }
  }, [open]);

  const handleClose = () => {
    cancelNewGame();
  };

  const handleConfirm = (syndicateId: SyndicateId) => {
    confirmNewGame(syndicateId);
  };

  const eyebrow = phase === "intro"
    ? (intent === "reset" ? "Restart this game" : "Welcome aboard")
    : phase === "pilot"
      ? (intent === "reset" ? "Recreate your pilot" : "Build your pilot")
      : (intent === "reset" ? "Restart this game" : "Choose your syndicate");

  const title = phase === "intro"
    ? "Ledgway — a sci-fi spreadsheet"
    : phase === "pilot"
      ? "Who's at the helm?"
      : "Pick a syndicate";

  const dialogClassName = phase === "pilot" ? "new-game-dialog new-game-dialog-pilot" : "new-game-dialog";

  return (
    <Modal
      open={open}
      onClose={handleClose}
      eyebrow={eyebrow}
      title={title}
      dialogClassName={dialogClassName}
      closeOnBackdrop={false}
      footer={
        phase === "intro" ? (
          <>
            <button type="button" className="ui-modal-btn" onClick={handleClose}>
              Cancel
            </button>
            <button type="button" className="ui-modal-btn primary" onClick={() => advance("pilot")}>
              Continue
            </button>
          </>
        ) : phase === "pilot" ? (
          <PilotFooter draft={draft} onCancel={handleClose} onContinue={() => advance("syndicate")} />
        ) : (
          <SyndicateFooter
            picked={pickedSyndicate}
            intent={intent}
            onCancel={handleClose}
            onBack={() => advance("pilot")}
            onConfirm={() => pickedSyndicate && handleConfirm(pickedSyndicate)}
          />
        )
      }
    >
      {phase === "intro" && <IntroPhase />}
      {phase === "pilot" && draft && (
        <PilotPhase
          draft={draft}
          onChange={setDraft}
        />
      )}
      {phase === "syndicate" && pending && (
        <SyndicatePhase
          previewWorld={pending.previewWorld}
          picked={pickedSyndicate}
          onPick={setPickedSyndicate}
        />
      )}
    </Modal>
  );
}

// ----- Intro --------------------------------------------------------------

function IntroPhase() {
  return (
    <div className="new-game-intro-phase">
      <p className="new-game-intro">
        A trading sim played at the keyboard. Move goods, build a fleet, and
        bet on the markets that move with you.
      </p>
      <div className="new-game-intro-grid">
        <IntroTile
          title="Trade"
          body="Buy goods cheap at one station, sell them dear at another. Watch the spread."
        />
        <IntroTile
          title="Fleet"
          body="Each ship has its own wallet, crew, and cargo. Hire pilots to run routes for you."
        />
        <IntroTile
          title="Speculate"
          body="The Exchange lets you go long, short, or write futures on stations and commodities."
        />
      </div>
    </div>
  );
}

function IntroTile({ title, body }: { title: string; body: string }) {
  return (
    <div className="new-game-intro-tile">
      <div className="new-game-intro-tile-title">{title}</div>
      <div className="new-game-intro-tile-body">{body}</div>
    </div>
  );
}

// ----- Pilot --------------------------------------------------------------

interface PilotPhaseProps {
  draft: PilotDraft;
  onChange: (next: PilotDraft) => void;
}

function PilotPhase({ draft, onChange }: PilotPhaseProps) {
  const handleField = <K extends keyof PilotDraft>(key: K, value: PilotDraft[K]) => {
    onChange({ ...draft, [key]: value });
  };

  const handleIdentity = <K extends keyof CrewIdentity>(key: K, value: CrewIdentity[K]) => {
    onChange({ ...draft, identity: { ...draft.identity, [key]: value } });
  };

  return (
    <div className="new-game-pilot-grid">
      <div className="new-game-pilot-form">
        <div className="new-game-pilot-field">
          <label className="new-game-pilot-label" htmlFor="pilot-name">Name</label>
          <div className="new-game-pilot-name-row">
            <input
              id="pilot-name"
              className="new-game-pilot-name"
              type="text"
              value={draft.name}
              maxLength={32}
              onChange={(e) => handleField("name", e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <button
              type="button"
              className="new-game-pilot-dice"
              title="Roll a random name"
              aria-label="Roll a random name"
              onClick={() => handleField("name", randomPilotName())}
            >
              <MdCasino aria-hidden="true" focusable="false" />
            </button>
          </div>
        </div>

        <SegmentedField<CrewRace>
          label="Race"
          options={CREW_RACES}
          value={draft.identity.race}
          onChange={(v) => handleIdentity("race", v)}
        />
        <SegmentedField<CrewSex>
          label="Sex"
          options={CREW_SEXES}
          value={draft.identity.sex}
          onChange={(v) => handleIdentity("sex", v)}
        />
        <SegmentedField<CrewAge>
          label="Age"
          options={CREW_AGES}
          value={draft.identity.age}
          onChange={(v) => handleIdentity("age", v)}
        />

        <div className="new-game-pilot-field">
          <label className="new-game-pilot-label" htmlFor="pilot-vibe">Vibe</label>
          <input
            id="pilot-vibe"
            className="new-game-pilot-vibe"
            type="text"
            value={draft.clothing}
            maxLength={120}
            placeholder="freighter captain coat with shoulder bars…"
            onChange={(e) => handleField("clothing", e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
          <div className="new-game-pilot-chips">
            {VIBE_CHIPS.map(chip => (
              <button
                key={chip}
                type="button"
                className={`new-game-pilot-chip ${draft.clothing === chip ? "active" : ""}`}
                onClick={() => handleField("clothing", chip)}
              >
                {chip.split(" ").slice(0, 3).join(" ")}
              </button>
            ))}
          </div>
        </div>
      </div>

      <PilotPortrait
        draft={draft}
        onReroll={() => onChange({ ...draft, portraitVariant: draft.portraitVariant + 1 })}
      />
    </div>
  );
}

function SegmentedField<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (next: T) => void;
}) {
  return (
    <div className="new-game-pilot-field">
      <span className="new-game-pilot-label">{label}</span>
      <div className="new-game-pilot-segments" role="radiogroup" aria-label={label}>
        {options.map(opt => (
          <button
            key={opt}
            type="button"
            role="radio"
            aria-checked={value === opt}
            className={`new-game-pilot-segment ${value === opt ? "active" : ""}`}
            onClick={() => onChange(opt)}
          >
            {opt}
          </button>
        ))}
      </div>
    </div>
  );
}

// Headshot generation is uncached for the pilot — clothing is always
// supplied (we synthesize one if blank) so the server routes through the
// unique entry path. Each reroll bumps portraitVariant which is folded
// into the subjectId so the next allocate forces a fresh image.
function pilotSubjectId(draft: PilotDraft): string {
  return `${draft.portraitId}_v${draft.portraitVariant}`;
}

function pilotClothing(draft: PilotDraft): string {
  return draft.clothing.trim() || "freighter captain coat with subtle ship insignia";
}

type PortraitStatus = "idle" | "loading" | "ready" | "failed";

function PilotPortrait({ draft, onReroll }: { draft: PilotDraft; onReroll: () => void }) {
  const hasRequested = draft.portraitVariant > 0;
  const subjectId = pilotSubjectId(draft);
  const clothing = pilotClothing(draft);

  // We only build a non-null subject after the first reroll click —
  // useCrewHeadshot only fires its allocate effect when subject is
  // truthy, so the API stays untouched until the player explicitly
  // asks for a portrait.
  const subject = useMemo(() => hasRequested ? {
    id: subjectId,
    role: "captain" as const,
    sex: draft.identity.sex,
    age: draft.identity.age,
    race: draft.identity.race,
    clothing,
  } : null, [hasRequested, subjectId, draft.identity.sex, draft.identity.age, draft.identity.race, clothing]);

  const headshot = useCrewHeadshot(null, subject);
  const status: PortraitStatus = !hasRequested
    ? "idle"
    : (headshot?.status ?? "loading");
  const progress = useFakeHeadshotProgress(status, subjectId);
  const ready = status === "ready";
  const loading = status === "loading";

  const buttonLabel = status === "idle" ? "Generate portrait"
    : status === "ready" ? "Reroll portrait"
    : status === "failed" ? "Try again"
    : "Generating…";

  return (
    <div className="new-game-pilot-portrait">
      <div className={`new-game-pilot-portrait-frame ${ready ? "ready" : ""} ${loading ? "loading" : ""}`}>
        {ready && headshot && headshot.status === "ready" ? (
          <img
            className="new-game-pilot-portrait-img"
            src={headshot.url}
            alt={`Portrait of ${draft.name || "pilot"}`}
          />
        ) : status === "idle" ? (
          <div className="new-game-pilot-portrait-idle" aria-hidden="true">
            <span>No portrait yet</span>
          </div>
        ) : (
          <div className="new-game-pilot-portrait-placeholder" aria-hidden="true">
            <div className="new-game-pilot-portrait-shimmer" />
          </div>
        )}
        {loading && (
          <div className="new-game-pilot-portrait-progress" aria-hidden="true">
            <div className="new-game-pilot-portrait-progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
          </div>
        )}
      </div>
      <div className="new-game-pilot-portrait-actions">
        <button
          type="button"
          className="new-game-pilot-reroll"
          onClick={onReroll}
          disabled={loading}
          title={status === "idle" ? "Generate a portrait with these traits" : "Generate a new portrait with these traits"}
        >
          <MdRefresh aria-hidden="true" focusable="false" />
          <span>{buttonLabel}</span>
        </button>
        <p className="new-game-pilot-portrait-hint">
          {status === "idle"
            ? "Set your traits, then click to generate a portrait. Takes about 15 seconds."
            : "Edit any trait above and click reroll for a new face."}
        </p>
      </div>
    </div>
  );
}

// Drives a fake progress fill from 0 → 95% over HEADSHOT_FAKE_DURATION_MS,
// then stalls until the headshot resolves (snaps to 100% on ready, resets
// on a new subject id). Idle state holds at 0; the bar only animates while
// a request is in flight.
function useFakeHeadshotProgress(status: PortraitStatus, subjectId: string): number {
  const [progress, setProgress] = useState(0);
  const startedRef = useRef<number | null>(null);

  useEffect(() => {
    setProgress(0);
    startedRef.current = performance.now();
  }, [subjectId]);

  useEffect(() => {
    if (status === "idle") {
      setProgress(0);
      return;
    }
    if (status === "ready") {
      setProgress(1);
      return;
    }
    if (status === "failed") {
      setProgress(0);
      return;
    }
    let raf = 0;
    const tick = () => {
      const start = startedRef.current ?? performance.now();
      const elapsed = performance.now() - start;
      // Ease toward 0.95 over the budget so we hit roughly 60% halfway
      // through and stall at 95% once we exceed the budget.
      const ratio = Math.min(1, elapsed / HEADSHOT_FAKE_DURATION_MS);
      const eased = 0.95 * (1 - Math.pow(1 - ratio, 1.4));
      setProgress(prev => Math.max(prev, eased));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [status, subjectId]);

  return progress;
}

function PilotFooter({ draft, onCancel, onContinue }: { draft: PilotDraft | null; onCancel: () => void; onContinue: () => void }) {
  const ready = !!draft && draft.name.trim().length > 0;
  return (
    <>
      <button type="button" className="ui-modal-btn" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="ui-modal-btn primary" disabled={!ready} onClick={onContinue}>
        Continue
      </button>
    </>
  );
}

// ----- Syndicate ---------------------------------------------------------

function SyndicatePhase({ previewWorld, picked, onPick }: {
  previewWorld: World;
  picked: SyndicateId | null;
  onPick: (id: SyndicateId) => void;
}) {
  const syndicates = useMemo(() => sortedSyndicates(previewWorld), [previewWorld]);
  const stationCounts = useMemo(() => countStationsBySyndicate(previewWorld), [previewWorld]);

  return (
    <>
      <p className="new-game-intro">
        Each seed produces a fresh roster of factions. Pick the syndicate
        you'll join — your ship inherits their colors, their trait, and
        a starting berth at their outpost.
      </p>
      <div className="new-game-grid">
        {syndicates.map(synd => {
          const trait = synd.traitId ? SYNDICATE_TRAITS[synd.traitId] : null;
          const accent = synd.accentHex ?? "#9bb6c8";
          const stationCount = stationCounts.get(synd.id) ?? 0;
          const selected = picked === synd.id;
          return (
            <button
              key={synd.id}
              type="button"
              className={`new-game-card ${selected ? "selected" : ""}`}
              style={{ "--syndicate-accent": accent } as React.CSSProperties}
              onClick={() => onPick(synd.id)}
            >
              <span className="new-game-card-swatch" aria-hidden="true" />
              <div className="new-game-card-body">
                <div className="new-game-card-name">{synd.name}</div>
                {trait && (
                  <>
                    <div className="new-game-card-trait">{trait.label}</div>
                    <div className="new-game-card-desc">{trait.description}</div>
                  </>
                )}
                <div className="new-game-card-foot">
                  <span>{stationCount} station{stationCount === 1 ? "" : "s"}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

function SyndicateFooter({ picked, intent, onCancel, onBack, onConfirm }: {
  picked: SyndicateId | null;
  intent: "create" | "reset";
  onCancel: () => void;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <>
      <button type="button" className="ui-modal-btn" onClick={onCancel}>
        Cancel
      </button>
      <button type="button" className="ui-modal-btn" onClick={onBack}>
        Back
      </button>
      <button type="button" className="ui-modal-btn primary" disabled={!picked} onClick={onConfirm}>
        {intent === "reset" ? "Restart with this syndicate" : "Begin"}
      </button>
    </>
  );
}

function sortedSyndicates(world: World): Syndicate[] {
  return Object.values(world.syndicates).sort((a, b) => a.id.localeCompare(b.id));
}

function countStationsBySyndicate(world: World): Map<SyndicateId, number> {
  const counts = new Map<SyndicateId, number>();
  for (const loc of Object.values(world.locations)) {
    const f = loc.traits.faction;
    if (!f) continue;
    counts.set(f, (counts.get(f) ?? 0) + 1);
  }
  return counts;
}
