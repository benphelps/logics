import { useEffect, useState } from "react";
import { useStore } from "../store";
import { Modal } from "./Modal";
import "./SeedingModal.css";

const QUOTE_INTERVAL_MS = 2000;

// Shown during the new-game seeding phase: a chunked tickWorld loop runs
// in the background while we rotate through quirky themed loading lines.
// The modal is non-dismissable — the seeding loop in store.ts is what
// clears `pendingSeed` once the wall-clock budget is up.
export function SeedingModal() {
  const seed = useStore(s => s.pendingSeed);
  const [now, setNow] = useState(() => performance.now());

  useEffect(() => {
    if (!seed) return;
    let raf = 0;
    const tick = () => {
      setNow(performance.now());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [seed]);

  if (!seed) return null;

  const elapsed = Math.max(0, now - seed.startedAt);
  const isBackstory = seed.phase === "backstory";
  const totalQuoteSlots = Math.max(1, Math.ceil(seed.durationMs / QUOTE_INTERVAL_MS));
  const slot = Math.min(totalQuoteSlots - 1, Math.floor(elapsed / QUOTE_INTERVAL_MS));
  const quote = seed.quotes[Math.min(slot, seed.quotes.length - 1)] ?? "Reticulating splines";
  // Backstory phase has no fixed duration — show an indeterminate pulse
  // bar instead of a true progress fill.
  const progressPct = isBackstory ? 100 : Math.min(100, (elapsed / seed.durationMs) * 100);

  return (
    <Modal
      open={true}
      onClose={() => { /* non-dismissable */ }}
      closeOnBackdrop={false}
      eyebrow={isBackstory ? "Writing universe history" : "Seeding the universe"}
      title={isBackstory ? "Drafting the backstory" : "Settling the sector"}
      dialogClassName="seeding-dialog"
    >
      <p className="seeding-quote mono">{isBackstory ? "Listening to the syndicates" : quote}…</p>
      <div className={`seeding-progress${isBackstory ? " indeterminate" : ""}`} aria-hidden>
        <div className="seeding-progress-fill" style={{ width: `${progressPct}%` }} />
      </div>
      <p className="seeding-hint dim">
        {isBackstory
          ? "Our wire-service desk is sketching the political and economic shape of your universe. This unlocks the news system's continuity layer."
          : "NPC freighters are running their first runs while you wait. The picker locks until the universe has a bit of history under it."}
      </p>
    </Modal>
  );
}
