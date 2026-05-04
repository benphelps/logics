import { useStore } from "../store";
import { Modal } from "./Modal";

// Splash for the brief moment between cold-start (or load-from-menu)
// and the active save's world arriving from IndexedDB. Reuses the
// seeding-dialog styles to feel like a continuation of the new-game
// loading bar; the bar here pulses indefinitely since IDB latency is
// short and unpredictable.
export function SaveLoadingModal() {
  const pending = useStore((s) => s.pendingWorldLoad);
  if (!pending) return null;
  return (
    <Modal
      open={true}
      onClose={() => { /* non-dismissable */ }}
      closeOnBackdrop={false}
      eyebrow="Loading"
      title="Restoring your save"
      dialogClassName="seeding-dialog"
    >
      <p className="seeding-quote mono">Pulling save from local storage…</p>
      <div className="seeding-progress save-loading-progress" aria-hidden>
        <div className="seeding-progress-fill save-loading-pulse" />
      </div>
      <p className="seeding-hint dim">
        World data lives in your browser's IndexedDB. This usually finishes in well under a second.
      </p>
    </Modal>
  );
}
