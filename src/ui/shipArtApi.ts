// Hook + helpers for the dynamic ship-art splash. The fleet info card
// (and any other panel that wants a class-aware ship hero) calls
// `useShipArtImageUrl(ship)` to ask the /api/ship-art/for-ship endpoint
// for either a cached image or a pending entry. While the upstream
// (Gemini Flash Image by default) generates, the hook keeps polling
// the entry's statusUrl every 1.5s; once ready, it swaps to the API
// image. The hook returns null until ready so callers can fall back to
// the static `shipArtUrl(ship)` in the meantime.

import { useEffect, useRef, useState } from "react";
import type { ShipClass, ShipTrait, Trader } from "../sim/types";

interface ShipArtEntryPointer {
  id: string;
  status: "pending" | "ready" | "failed";
  imageUrl?: string;
  statusUrl: string;
  error?: string;
}

interface ShipArtForShipResponse {
  source: "cache" | "pending";
  entry: ShipArtEntryPointer;
}

const POLL_INTERVAL_MS = 1500;
// Bound polling so a stuck server-side generation can't keep the
// client looping forever. ~3 minutes covers the slowest model
// (gpt-image-2 high ≈ 2 min) plus headroom.
const POLL_TIMEOUT_MS = 180_000;

const SUPPORTED_CLASSES: ShipClass[] = ["freighter", "courier", "hauler", "cruiser", "exotic"];

function inferClass(ship: Trader): ShipClass | null {
  if (ship.shipClass) return ship.shipClass;
  // For ships minted outside the shipyard system (the starting
  // Voyager, NPC traders), guess from stats so the splash still looks
  // sensible. Mirrors shipArtFamily()'s tiebreakers.
  if (ship.capacity >= 130) return "hauler";
  if (ship.speed >= 1.6) return "courier";
  if ((ship.weaponPower ?? ship.baseWeaponPower ?? 0) >= 3) return "cruiser";
  if (ship.capacity <= 60) return "courier";
  return "freighter";
}

// Stable cache-shaped key per ship for React effect deps. We don't
// want art to flicker every tick when ship.funds changes, so the dep
// only includes the fields the prompt cares about.
function shipKey(ship: Trader): string {
  return [
    ship.id,
    ship.shipClass ?? inferClass(ship) ?? "",
    (ship.traits ?? []).slice().sort().join(","),
  ].join("|");
}

export interface ShipArtState {
  // The API image url once ready. While loading or failed, null —
  // callers should fall back to the static art in that case.
  imageUrl: string | null;
  status: "idle" | "pending" | "ready" | "failed";
  error?: string;
}

export function useShipArtImageUrl(ship: Trader | null): ShipArtState {
  const [state, setState] = useState<ShipArtState>({ imageUrl: null, status: "idle" });
  const pollAbort = useRef<AbortController | null>(null);
  const key = ship ? shipKey(ship) : "";

  useEffect(() => {
    if (!ship) {
      setState({ imageUrl: null, status: "idle" });
      return;
    }
    const cls = inferClass(ship);
    if (!cls || !SUPPORTED_CLASSES.includes(cls)) {
      setState({ imageUrl: null, status: "idle" });
      return;
    }

    const controller = new AbortController();
    pollAbort.current?.abort();
    pollAbort.current = controller;
    const traits = (ship.traits ?? []).filter((t): t is ShipTrait => Boolean(t));

    setState({ imageUrl: null, status: "pending" });

    void (async () => {
      try {
        const seedResponse = await fetch("/api/ship-art/for-ship", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ class: cls, traits, name: ship.name }),
          signal: controller.signal,
        });
        if (!seedResponse.ok) {
          const detail = await safeError(seedResponse);
          setState({ imageUrl: null, status: "failed", error: detail });
          return;
        }
        const seed = await seedResponse.json() as ShipArtForShipResponse;
        if (seed.entry.status === "ready" && seed.entry.imageUrl) {
          setState({ imageUrl: seed.entry.imageUrl, status: "ready" });
          return;
        }
        if (seed.entry.status === "failed") {
          setState({ imageUrl: null, status: "failed", error: seed.entry.error });
          return;
        }

        // Pending — poll status URL until ready or failed.
        const statusUrl = seed.entry.statusUrl;
        const deadline = Date.now() + POLL_TIMEOUT_MS;
        while (Date.now() < deadline) {
          if (controller.signal.aborted) return;
          await delay(POLL_INTERVAL_MS, controller.signal);
          if (controller.signal.aborted) return;
          const polled = await fetch(statusUrl, { signal: controller.signal });
          // 202 = still pending, 200 = ready, 500 = failed.
          if (polled.status === 202) continue;
          const body = await polled.json().catch(() => null) as { entry?: ShipArtEntryPointer } | null;
          const entry = body?.entry;
          if (entry?.status === "ready" && entry.imageUrl) {
            setState({ imageUrl: entry.imageUrl, status: "ready" });
            return;
          }
          if (entry?.status === "failed") {
            setState({ imageUrl: null, status: "failed", error: entry.error });
            return;
          }
          if (!polled.ok && polled.status !== 202) {
            setState({ imageUrl: null, status: "failed", error: `status ${polled.status}` });
            return;
          }
        }
        // Timed out — leave state as pending so the caller keeps the
        // static fallback rather than flashing an error.
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "ship-art lookup failed";
        setState({ imageUrl: null, status: "failed", error: message });
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- key collapses
    // the relevant Trader fields into one stable string.
  }, [key]);

  return state;
}

async function safeError(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: string };
    return body.error ?? `status ${response.status}`;
  } catch {
    return `status ${response.status}`;
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new DOMException("aborted", "AbortError")); return; }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
}
