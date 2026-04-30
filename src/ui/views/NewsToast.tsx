import { useEffect } from "react";
import { useStore } from "../store";
import "./NewsToast.css";

const TOAST_DURATION_MS = 6_000;

export function NewsToast() {
  const toasts = useStore((s) => s.newsToasts);
  const dismiss = useStore((s) => s.dismissNewsToast);

  useEffect(() => {
    if (toasts.length === 0) return;
    const oldest = toasts[0];
    const handle = window.setTimeout(() => dismiss(oldest.uid), TOAST_DURATION_MS);
    return () => window.clearTimeout(handle);
  }, [toasts, dismiss]);

  if (toasts.length === 0) return null;
  return (
    <div className="news-toast-stack">
      {toasts.slice(-3).map((t) => (
        <div key={t.uid} className={`news-toast tone-${t.tone}`} role="status" onClick={() => dismiss(t.uid)}>
          <div className="news-toast-head">
            <span className="news-toast-cat">{t.category}</span>
            <span className="news-toast-headline">{t.headline}</span>
          </div>
          <div className="news-toast-body">{t.body}</div>
        </div>
      ))}
    </div>
  );
}
