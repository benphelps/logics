import { useMemo, useState } from "react";
import type { Syndicate, SyndicateId, World } from "../../sim/types";
import { SYNDICATE_TRAITS } from "../../sim/data/syndicates";
import { useStore } from "../store";
import { Modal } from "./Modal";
import "./NewGameModal.css";

export function NewGameModal() {
  const pending = useStore(s => s.pendingNewGame);
  const confirmNewGame = useStore(s => s.confirmNewGame);
  const cancelNewGame = useStore(s => s.cancelNewGame);
  const [picked, setPicked] = useState<SyndicateId | null>(null);

  const open = pending != null;
  const intent = pending?.intent ?? "create";
  const syndicates = useMemo(
    () => (pending ? sortedSyndicates(pending.previewWorld) : []),
    [pending],
  );
  const stationCounts = useMemo(
    () => (pending ? countStationsBySyndicate(pending.previewWorld) : new Map<SyndicateId, number>()),
    [pending],
  );

  const handleClose = () => {
    setPicked(null);
    cancelNewGame();
  };

  const handleConfirm = () => {
    if (!picked) return;
    setPicked(null);
    confirmNewGame(picked);
  };

  return (
    <Modal
      open={open}
      onClose={handleClose}
      eyebrow={intent === "reset" ? "Restart this game" : "Begin a new game"}
      title="Choose your syndicate"
      dialogClassName="new-game-dialog"
      closeOnBackdrop={false}
      footer={
        <>
          <button type="button" className="ui-modal-btn" onClick={handleClose}>
            Cancel
          </button>
          <button
            type="button"
            className="ui-modal-btn primary"
            onClick={handleConfirm}
            disabled={!picked}
          >
            {intent === "reset" ? "Restart with this syndicate" : "Begin"}
          </button>
        </>
      }
    >
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
              onClick={() => setPicked(synd.id)}
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
    </Modal>
  );
}

function sortedSyndicates(world: World): Syndicate[] {
  // Stable order — by id (which is `syn_1` … `syn_N`) so the picker
  // doesn't shuffle between renders or seeds.
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
