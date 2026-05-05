import { useEffect, useRef, useState, type ReactNode } from "react";
import "./Modal.css";

// Match the exit-animation duration in Modal.css. Bumping this here without
// also adjusting the keyframe (or vice versa) leaves a stale-frame flash.
const MODAL_EXIT_MS = 160;

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  eyebrow?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  // When true, clicking the dimmed backdrop closes the modal. Disable
  // for flows that must end with an explicit action (e.g. an in-progress
  // multi-step wizard).
  closeOnBackdrop?: boolean;
  // Optional className applied to the dialog box for one-off width or
  // padding overrides.
  dialogClassName?: string;
}

export function Modal({
  open,
  onClose,
  title,
  eyebrow,
  children,
  footer,
  closeOnBackdrop = true,
  dialogClassName,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // We keep the modal mounted for one extra animation frame after `open`
  // flips to false so the exit keyframes can play. `mounted` tracks whether
  // anything renders at all; `exiting` toggles the CSS class that drives
  // the fade-out.
  const [mounted, setMounted] = useState(open);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      setExiting(false);
      return;
    }
    if (!mounted) return;
    setExiting(true);
    const t = setTimeout(() => {
      setMounted(false);
      setExiting(false);
    }, MODAL_EXIT_MS);
    return () => clearTimeout(t);
  }, [open, mounted]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    dialogRef.current?.focus();
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      className={`ui-modal-backdrop ${exiting ? "exiting" : ""}`}
      onClick={() => {
        if (exiting) return;
        if (closeOnBackdrop) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`ui-modal-dialog ${exiting ? "exiting" : ""} ${dialogClassName ?? ""}`}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        onClick={event => event.stopPropagation()}
      >
        <header className="ui-modal-head">
          {eyebrow && <span className="ui-modal-eyebrow">{eyebrow}</span>}
          <h2 className="ui-modal-title">{title}</h2>
        </header>
        <div className="ui-modal-body">{children}</div>
        {footer && <footer className="ui-modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
