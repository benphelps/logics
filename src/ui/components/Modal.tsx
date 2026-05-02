import { useEffect, useRef, type ReactNode } from "react";
import "./Modal.css";

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

  if (!open) return null;
  return (
    <div
      className="ui-modal-backdrop"
      onClick={() => {
        if (closeOnBackdrop) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`ui-modal-dialog ${dialogClassName ?? ""}`}
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
