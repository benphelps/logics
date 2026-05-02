// Hook for the dynamic syndicate-insignia art splash. Mirrors the
// ship-art hook pattern: hits /api/syndicate-insignia/for-syndicate to
// get a cache hit (immediate) or a pending entry (poll until ready).
// Callers fall back to a static gradient swatch while the upstream
// generation is in flight.

import { useEffect, useRef, useState } from "react";
import type { Syndicate } from "../sim/types";

interface InsigniaEntry {
  id: string;
  status: "pending" | "ready" | "failed";
  imageUrl: string | null;
  statusUrl: string;
  error?: string;
}

interface InsigniaForSyndicateResponse {
  source: "cache" | "pending" | "fresh";
  entry: InsigniaEntry;
}

export interface SyndicateInsigniaState {
  imageUrl: string | null;
  status: "idle" | "pending" | "ready" | "failed";
  error?: string;
}

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 180_000;

export function useSyndicateInsigniaImageUrl(syndicate: Syndicate | null): SyndicateInsigniaState {
  const [state, setState] = useState<SyndicateInsigniaState>({ imageUrl: null, status: "idle" });
  const abortRef = useRef<AbortController | null>(null);

  // Stable dep key: re-run only when the syndicate identity / accent /
  // trait changes — re-rendering due to other store state shouldn't
  // re-trigger the network call.
  const depKey = syndicate
    ? `${syndicate.id}|${syndicate.accentHex ?? ""}|${syndicate.traitId ?? ""}`
    : "";

  useEffect(() => {
    if (!syndicate || !syndicate.accentHex) {
      setState({ imageUrl: null, status: "idle" });
      return;
    }
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setState({ imageUrl: null, status: "pending" });

    void (async () => {
      try {
        const seedResponse = await fetch("/api/syndicate-insignia/for-syndicate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            syndicateId: syndicate.id,
            name: syndicate.name,
            accentHex: syndicate.accentHex,
            traitId: syndicate.traitId,
          }),
          signal: controller.signal,
        });
        if (!seedResponse.ok) {
          setState({ imageUrl: null, status: "failed", error: await safeError(seedResponse) });
          return;
        }
        const seed = await seedResponse.json() as InsigniaForSyndicateResponse;
        if (seed.entry.status === "ready" && seed.entry.imageUrl) {
          setState({ imageUrl: seed.entry.imageUrl, status: "ready" });
          return;
        }
        if (seed.entry.status === "failed") {
          setState({ imageUrl: null, status: "failed", error: seed.entry.error });
          return;
        }
        // Poll status until ready or failed.
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (controller.signal.aborted) return;
          await delay(POLL_INTERVAL_MS, controller.signal);
          if (controller.signal.aborted) return;
          const polled = await fetch(seed.entry.statusUrl, { signal: controller.signal });
          if (!polled.ok) continue;
          const body = await polled.json().catch(() => null) as { entry?: InsigniaEntry } | null;
          const entry = body?.entry;
          if (entry?.status === "ready" && entry.imageUrl) {
            setState({ imageUrl: entry.imageUrl, status: "ready" });
            return;
          }
          if (entry?.status === "failed") {
            setState({ imageUrl: null, status: "failed", error: entry.error });
            return;
          }
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "insignia lookup failed";
        setState({ imageUrl: null, status: "failed", error: message });
      }
    })();
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depKey collapses the prompt-shaping fields.
  }, [depKey]);

  return state;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function safeError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string };
    return body.error ?? `status ${res.status}`;
  } catch {
    return `status ${res.status}`;
  }
}
