// Client-side headshot pool. Talks to the dev-server `/api/headshots/*`
// endpoints to allocate a portrait per crew member or hire offer, polls
// until the image is ready, and exposes the result as a subscribable
// cache so React components can reactively pick up newly-arrived images
// without a dedicated zustand slice.
//
// The cache key (and the `subjectId` we send to the server) is the
// CrewMember/Hire id — that id is reused from the originating offer when
// snapshotted onto the ship, so the same face follows a crew member from
// the offer board into the ship and back through reloads. When an offer
// expires unhired, or a crew member is fired, the store calls
// `releaseCrewHeadshots` so the image returns to the unused pool and
// can be assigned to the next crew of the same identity tuple.

import { useEffect, useSyncExternalStore } from "react";
import type { CrewAge, CrewIdentity, CrewRace, CrewRole, CrewSex } from "../sim/types";
import { deriveCrewIdentity, headshotRoleFor } from "../sim/crewIdentity";

export interface HeadshotSubject {
  id: string;
  role: CrewRole;
  sex?: CrewSex;
  age?: CrewAge;
  race?: CrewRace;
  // Free-text outfit/vibe forwarded to the headshot API. Crew don't set
  // this (the server uses role-default clothing); the new-game wizard
  // sets it for pilot portraits so the player gets a face that matches
  // the vibe they wrote into the form.
  clothing?: string;
}

interface AllocateResponse {
  source: "pending" | "cache" | "generated";
  entry: {
    id: string;
    imageUrl: string;
    statusUrl: string;
    status: "pending" | "ready" | "failed";
    error?: string;
  };
}

interface StatusResponse {
  entry: {
    id: string;
    imageUrl: string;
    status: "pending" | "ready" | "failed";
    error?: string;
  };
}

export type HeadshotState =
  | { status: "loading" }
  | { status: "ready"; url: string }
  | { status: "failed" };

const cache = new Map<string, HeadshotState>();
const inflight = new Map<string, Promise<void>>();
const subscribers = new Set<() => void>();

let revision = 0;

function notify(): void {
  revision += 1;
  for (const listener of subscribers) listener();
}

function gameIdFromSaveId(saveId: string | null): number {
  if (!saveId) return 0;
  let h = 2166136261;
  for (let i = 0; i < saveId.length; i++) {
    h ^= saveId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) & 0x7fffffff;
}

function effectiveIdentity(subject: HeadshotSubject): CrewIdentity {
  if (subject.sex && subject.age && subject.race) {
    return { sex: subject.sex, age: subject.age, race: subject.race };
  }
  return deriveCrewIdentity(subject.id);
}

async function pollUntilReady(subjectId: string, statusUrl: string): Promise<void> {
  const delays = [1500, 2000, 3000, 4000, 5000, 7000, 10000];
  for (let attempt = 0; attempt < 60; attempt++) {
    const wait = delays[Math.min(attempt, delays.length - 1)];
    await new Promise((resolve) => setTimeout(resolve, wait));
    try {
      const response = await fetch(statusUrl);
      if (response.status === 202) continue;
      if (!response.ok) {
        cache.set(subjectId, { status: "failed" });
        notify();
        return;
      }
      const json = await response.json() as StatusResponse;
      if (json.entry.status === "ready") {
        cache.set(subjectId, { status: "ready", url: json.entry.imageUrl });
        notify();
        return;
      }
      if (json.entry.status === "failed") {
        cache.set(subjectId, { status: "failed" });
        notify();
        return;
      }
    } catch {
      // transient — keep polling
    }
  }
  cache.set(subjectId, { status: "failed" });
  notify();
}

function allocate(subjectId: string, role: CrewRole, identity: CrewIdentity, gameId: number, clothing?: string): Promise<void> {
  const existing = inflight.get(subjectId);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const response = await fetch(`/api/headshots/${gameId}/allocate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          role: headshotRoleFor(role),
          race: identity.race,
          sex: identity.sex,
          age: identity.age,
          subjectId,
          ...(clothing ? { clothing } : {}),
        }),
      });
      if (!response.ok && response.status !== 202) {
        cache.set(subjectId, { status: "failed" });
        notify();
        return;
      }
      const json = await response.json() as AllocateResponse;
      const entry = json.entry;
      if (entry.status === "ready") {
        cache.set(subjectId, { status: "ready", url: entry.imageUrl });
        notify();
        return;
      }
      if (entry.status === "failed") {
        cache.set(subjectId, { status: "failed" });
        notify();
        return;
      }
      await pollUntilReady(subjectId, entry.statusUrl);
    } catch {
      cache.set(subjectId, { status: "failed" });
      notify();
    } finally {
      inflight.delete(subjectId);
    }
  })();

  inflight.set(subjectId, promise);
  return promise;
}

export function ensureCrewHeadshot(saveId: string | null, subject: HeadshotSubject): void {
  const existing = cache.get(subject.id);
  if (existing && existing.status !== "failed") return;
  if (inflight.has(subject.id)) return;
  cache.set(subject.id, { status: "loading" });
  notify();
  void allocate(subject.id, subject.role, effectiveIdentity(subject), gameIdFromSaveId(saveId), subject.clothing);
}

// Drop the local cache entry and tell the server to forget this subject's
// claim. Called when an offer expires unhired or a crew member is fired —
// the image returns to the pool and the next crew of the same identity
// tuple will reuse it. Best-effort; a failed network call is harmless
// (the server still has the claim, but the local cache is cleared).
export function releaseCrewHeadshots(saveId: string | null, subjectIds: readonly string[]): void {
  if (subjectIds.length === 0) return;
  const gameId = gameIdFromSaveId(saveId);
  let dirty = false;
  for (const subjectId of subjectIds) {
    if (cache.delete(subjectId)) dirty = true;
    inflight.delete(subjectId);
    void fetch(`/api/headshots/${gameId}/release`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subjectId }),
    }).catch(() => {});
  }
  if (dirty) notify();
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

function getRevision(): number {
  return revision;
}

// React hook — re-renders when *any* headshot changes. That's coarser
// than per-key subscribe, but the crew tab + offer board only render a
// handful of rows so the wider blast radius is fine.
//
// The `ensureCrewHeadshot` call is deferred into an effect so React
// doesn't see the resulting `notify()` as a setState during render of
// a sibling card.
export function useCrewHeadshot(saveId: string | null, subject: HeadshotSubject | null | undefined): HeadshotState | null {
  useSyncExternalStore(subscribe, getRevision, getRevision);
  const subjectId = subject?.id;
  const role = subject?.role;
  const sex = subject?.sex;
  const age = subject?.age;
  const race = subject?.race;
  const clothing = subject?.clothing;
  useEffect(() => {
    if (!subjectId || !role) return;
    ensureCrewHeadshot(saveId, { id: subjectId, role, sex, age, race, clothing });
  }, [saveId, subjectId, role, sex, age, race, clothing]);
  if (!subject) return null;
  return cache.get(subject.id) ?? { status: "loading" };
}
