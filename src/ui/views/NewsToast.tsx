import { useStore } from "../store";
import { describeEffect } from "./newsHelpers";
import "./NewsToast.css";

export function NewsToast() {
  const toasts = useStore((s) => s.newsToasts);
  const world = useStore((s) => s.world);
  const dismiss = useStore((s) => s.dismissNewsToast);

  if (toasts.length === 0) return null;
  return (
    <div className="news-toast-stack">
      {toasts.slice(-3).map((t) => (
        <div key={t.uid} className={`news-toast tone-${t.tone}`} role="status" onClick={() => dismiss(t.uid)}>
          <div className="news-toast-eyebrow">
            <span className="news-toast-tone" aria-hidden />
            <span className="news-toast-cat">{t.category}</span>
          </div>
          <div className="news-toast-headline">{t.headline}</div>
          <div className="news-toast-body">{t.body}</div>
          {t.effects.length > 0 && (
            <div className="news-toast-effects">
              {t.effects.map((eff, i) => (
                <span key={i} className="news-toast-effect-chip">{describeEffect(eff, world)}</span>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
