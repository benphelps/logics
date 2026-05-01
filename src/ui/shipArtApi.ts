// Hooks + helpers for the dynamic ship-art splash. Both ship traders
// (the fleet info card) and ship blueprints (the shipyard
// marketplace info panel) hit the same /api/ship-art/for-ship
// endpoint, just with their own shaped payload. The hook returns
// instantly with `status: "pending"` while a generation runs upstream;
// callers fall back to their static art until `imageUrl` lands.

import { useEffect, useRef, useState } from "react";
import type { ShipBlueprint, ShipClass, ShipTrait, Trader } from "../sim/types";

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

interface ShipArtPayload {
  class: ShipClass;
  traits: ShipTrait[];
  name?: string;
  flavor?: string;
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

export interface ShipArtState {
  // The API image url once ready. While loading or failed, null —
  // callers should fall back to the static art in that case.
  imageUrl: string | null;
  status: "idle" | "pending" | "ready" | "failed";
  error?: string;
}

// Shared core: kicks off the lookup-or-pending request, polls until
// the entry is ready, returns ShipArtState. The dep is a single
// stable string so React only re-runs when the prompt-shaping fields
// actually change.
function useShipArtForPayload(payload: ShipArtPayload | null, depKey: string): ShipArtState {
  const [state, setState] = useState<ShipArtState>({ imageUrl: null, status: "idle" });
  const pollAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!payload) {
      setState({ imageUrl: null, status: "idle" });
      return;
    }
    if (!SUPPORTED_CLASSES.includes(payload.class)) {
      setState({ imageUrl: null, status: "idle" });
      return;
    }

    const controller = new AbortController();
    pollAbort.current?.abort();
    pollAbort.current = controller;
    setState({ imageUrl: null, status: "pending" });

    void (async () => {
      try {
        const seedResponse = await fetch("/api/ship-art/for-ship", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            class: payload.class,
            traits: payload.traits,
            name: payload.name,
            flavor: payload.flavor,
          }),
          signal: controller.signal,
        });
        if (!seedResponse.ok) {
          setState({ imageUrl: null, status: "failed", error: await safeError(seedResponse) });
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
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "ship-art lookup failed";
        setState({ imageUrl: null, status: "failed", error: message });
      }
    })();

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- depKey
    // collapses the relevant prompt fields into one stable string.
  }, [depKey]);

  return state;
}

export function useShipArtImageUrl(ship: Trader | null): ShipArtState {
  const cls = ship ? inferClass(ship) : null;
  const traits = ship ? (ship.traits ?? []).filter((t): t is ShipTrait => Boolean(t)) : [];
  const payload: ShipArtPayload | null = ship && cls
    ? { class: cls, traits, name: ship.name }
    : null;
  const depKey = ship && cls
    ? [ship.id, cls, [...traits].sort().join(",")].join("|")
    : "";
  return useShipArtForPayload(payload, depKey);
}

export function useBlueprintArtImageUrl(blueprint: ShipBlueprint | null): ShipArtState {
  const payload: ShipArtPayload | null = blueprint
    ? {
        class: blueprint.class,
        traits: blueprint.traits ?? [],
        name: blueprint.name,
        flavor: blueprint.flavor,
      }
    : null;
  const depKey = blueprint
    ? [
        blueprint.id,
        blueprint.class,
        [...(blueprint.traits ?? [])].sort().join(","),
      ].join("|")
    : "";
  return useShipArtForPayload(payload, depKey);
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
