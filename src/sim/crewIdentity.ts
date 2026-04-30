// Identity attributes shared between hire generation, save migration, and the
// headshot service. Values match the headshot API contract verbatim so they
// can be passed through unchanged when allocating portrait images.

import type { CrewRole, CrewSex, CrewAge, CrewRace, CrewIdentity } from "./types";
import type { Rng } from "./gen/rng";

export const CREW_SEXES: readonly CrewSex[] = ["female", "male", "nonbinary"];
export const CREW_AGES: readonly CrewAge[] = ["young adult", "adult", "middle aged", "elderly"];
export const CREW_RACES: readonly CrewRace[] = ["human", "alien"];

// Sex/age skew toward more familiar presentations; aliens are rarer than
// humans but still common enough to feel like a normal part of the universe.
const SEX_WEIGHTS: { value: CrewSex; weight: number }[] = [
  { value: "female",    weight: 5 },
  { value: "male",      weight: 5 },
  { value: "nonbinary", weight: 1 },
];
const AGE_WEIGHTS: { value: CrewAge; weight: number }[] = [
  { value: "young adult",  weight: 3 },
  { value: "adult",        weight: 5 },
  { value: "middle aged",  weight: 3 },
  { value: "elderly",      weight: 1 },
];
const RACE_WEIGHTS: { value: CrewRace; weight: number }[] = [
  { value: "human", weight: 4 },
  { value: "alien", weight: 1 },
];

function pickWeighted<T>(rng: Rng, items: { value: T; weight: number }[]): T {
  const total = items.reduce((s, x) => s + x.weight, 0);
  let r = rng() * total;
  for (const x of items) {
    r -= x.weight;
    if (r <= 0) return x.value;
  }
  return items[items.length - 1].value;
}

export function rollCrewIdentity(rng: Rng): CrewIdentity {
  return {
    sex:  pickWeighted(rng, SEX_WEIGHTS),
    age:  pickWeighted(rng, AGE_WEIGHTS),
    race: pickWeighted(rng, RACE_WEIGHTS),
  };
}

// Stable identity derived purely from a crew/hire id. Used to backfill saves
// that pre-date the identity fields and as a fallback when calling the
// headshot service for a member missing an explicit identity.
export function deriveCrewIdentity(id: string): CrewIdentity {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const u = (h >>> 0);
  return {
    sex:  CREW_SEXES[u % CREW_SEXES.length],
    age:  CREW_AGES[(u >>> 8) % CREW_AGES.length],
    race: CREW_RACES[(u >>> 16) % CREW_RACES.length],
  };
}

// Internal CrewRole → headshot API role string. The API uses richer labels
// (e.g. "ship captain"), so we translate here rather than leaking those
// values into the rest of the sim.
export function headshotRoleFor(role: CrewRole): string {
  if (role === "captain") return "ship captain";
  return role;
}
