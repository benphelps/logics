import { useEffect, useRef, useState } from "react";
import type { ShipBlueprint, Trader, TraderId } from "../../sim/types";
import { useStore } from "../store";
import { Modal } from "./Modal";

export interface BuyShipModalProps {
  open: boolean;
  blueprint: ShipBlueprint | null;
  buyer: Trader | null;
  onClose: () => void;
}

type Phase =
  | { kind: "confirm" }
  | { kind: "rename"; shipId: TraderId; defaultName: string }
  | { kind: "error"; message: string };

export function BuyShipModal({ open, blueprint, buyer, onClose }: BuyShipModalProps) {
  const purchaseShip = useStore(s => s.purchaseShip);
  const renameShip = useStore(s => s.renameShip);
  const [phase, setPhase] = useState<Phase>({ kind: "confirm" });
  const [nameInput, setNameInput] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset to confirm step every time the modal reopens for a new blueprint.
  useEffect(() => {
    if (open) {
      setPhase({ kind: "confirm" });
      setNameInput("");
    }
  }, [open, blueprint?.id]);

  useEffect(() => {
    if (phase.kind === "rename") inputRef.current?.select();
  }, [phase.kind]);

  if (!blueprint) return null;

  const canConfirm = Boolean(buyer) && (buyer?.funds ?? 0) >= blueprint.price;

  const handleConfirm = () => {
    const newId = purchaseShip(blueprint.id);
    if (!newId) {
      const lastError = useStore.getState().lastError ?? "Purchase failed.";
      setPhase({ kind: "error", message: lastError });
      return;
    }
    setNameInput(blueprint.name);
    setPhase({ kind: "rename", shipId: newId, defaultName: blueprint.name });
  };

  const handleRenameSubmit = () => {
    if (phase.kind !== "rename") return;
    const trimmed = nameInput.trim();
    if (trimmed && trimmed !== phase.defaultName) {
      renameShip(phase.shipId, trimmed);
    }
    onClose();
  };

  const handleSkipRename = () => {
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      eyebrow={phase.kind === "rename" ? "Christen the new ship" : "Confirm purchase"}
      title={phase.kind === "rename" ? `${blueprint.classLabel} acquired` : `Buy ${blueprint.name}`}
      closeOnBackdrop={phase.kind !== "rename"}
      footer={
        phase.kind === "rename" ? (
          <>
            <button type="button" className="ui-modal-btn" onClick={handleSkipRename}>
              Keep "{phase.defaultName}"
            </button>
            <button
              type="button"
              className="ui-modal-btn primary"
              onClick={handleRenameSubmit}
              disabled={!nameInput.trim()}
            >
              Save name
            </button>
          </>
        ) : phase.kind === "error" ? (
          <button type="button" className="ui-modal-btn" onClick={onClose}>Close</button>
        ) : (
          <>
            <button type="button" className="ui-modal-btn" onClick={onClose}>Cancel</button>
            <button
              type="button"
              className="ui-modal-btn primary"
              onClick={handleConfirm}
              disabled={!canConfirm}
            >
              Buy for Ç{blueprint.price.toLocaleString()}
            </button>
          </>
        )
      }
    >
      {phase.kind === "confirm" && (
        <>
          <div className="ui-modal-section">
            <div className="ui-modal-section-title">Blueprint</div>
            <div className="ui-modal-line"><span>Class</span><span className="mono">{blueprint.classLabel}</span></div>
            <div className="ui-modal-line"><span>Cargo</span><span className="mono">{blueprint.baseCapacity}</span></div>
            <div className="ui-modal-line"><span>Speed</span><span className="mono">{blueprint.baseSpeed.toFixed(2)}</span></div>
            <div className="ui-modal-line"><span>Hull</span><span className="mono">{blueprint.baseHull}</span></div>
          </div>
          <div className="ui-modal-section">
            <div className="ui-modal-section-title">Payment</div>
            <div className="ui-modal-line">
              <span>Price</span>
              <span className="mono">Ç{blueprint.price.toLocaleString()}</span>
            </div>
            {buyer ? (
              <>
                <div className="ui-modal-line">
                  <span>Debit from</span>
                  <span className="mono">{buyer.name}</span>
                </div>
                <div className="ui-modal-line">
                  <span>Funds after</span>
                  <span className="mono">Ç{Math.max(0, Math.floor(buyer.funds - blueprint.price)).toLocaleString()}</span>
                </div>
                {!canConfirm && (
                  <div className="ui-modal-error">
                    {buyer.name} needs Ç{(blueprint.price - buyer.funds).toLocaleString()} more.
                  </div>
                )}
              </>
            ) : (
              <div className="ui-modal-error">No docked buyer ship — dock one of your ships at this shipyard to take delivery.</div>
            )}
          </div>
        </>
      )}

      {phase.kind === "rename" && (
        <>
          <div className="ui-modal-line dim">
            <span>Default name</span>
            <span className="mono">{phase.defaultName}</span>
          </div>
          <label className="ui-modal-section">
            <span className="ui-modal-section-title">New name</span>
            <input
              ref={inputRef}
              className="ui-modal-input"
              value={nameInput}
              onChange={event => setNameInput(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  handleRenameSubmit();
                }
              }}
              maxLength={32}
              placeholder={phase.defaultName}
              autoFocus
            />
          </label>
        </>
      )}

      {phase.kind === "error" && (
        <div className="ui-modal-error">{phase.message}</div>
      )}
    </Modal>
  );
}
