import { useEffect } from "react";
import type { ActiveNewsEvent } from "../../sim/news/types";
import type { World } from "../../sim/types";
import { useStore } from "../store";
import { describeEffect } from "./newsHelpers";
import "./NewsToast.css";

// Auto-dismiss timeout per toast. Long enough that a player who flicks
// their eyes away can read the headline + body on return; short enough
// that the bottom-right corner doesn't accumulate stale toasts.
const AUTO_HIDE_MS = 5000;

export function NewsToast() {
  const toasts = useStore((s) => s.newsToasts);
  const world = useStore((s) => s.world);
  const dismiss = useStore((s) => s.dismissNewsToast);

  if (toasts.length === 0) return null;
  return (
    <div className="news-toast-stack">
      {toasts.slice(-3).map((t) => (
        <ToastItem key={t.uid} toast={t} world={world} onDismiss={dismiss} />
      ))}
    </div>
  );
}

interface ToastItemProps {
  toast: ActiveNewsEvent;
  world: World;
  onDismiss: (uid: string) => void;
}

function ToastItem({ toast, world, onDismiss }: ToastItemProps) {
  // One timer per toast — keyed by uid so the auto-hide clock doesn't
  // reset for existing toasts when a new one enters the stack.
  useEffect(() => {
    const timer = window.setTimeout(() => onDismiss(toast.uid), AUTO_HIDE_MS);
    return () => window.clearTimeout(timer);
  }, [toast.uid, onDismiss]);

  return (
    <div className={`news-toast tone-${toast.tone}`} role="status" onClick={() => onDismiss(toast.uid)}>
      <div className="news-toast-eyebrow">
        <span className="news-toast-tone" aria-hidden />
        <span className="news-toast-cat">{toast.category}</span>
      </div>
      <div className="news-toast-headline">{toast.headline}</div>
      <div className="news-toast-body">{toast.body}</div>
      {toast.effects.length > 0 && (
        <div className="news-toast-effects">
          {toast.effects.map((eff, i) => (
            <span key={i} className="news-toast-effect-chip">{describeEffect(eff, world)}</span>
          ))}
        </div>
      )}
    </div>
  );
}
