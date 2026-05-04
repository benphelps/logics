// Action-count gating. The player's career manualActionCount drives a small
// table of unlocks: navigator/mechanic/captain hire offers, and tier-gated
// upgrade stocking. The single source of truth is MILESTONES — every
// gameplay gate reads from here so retuning is a one-file change.
//
// "Manual action" = anything the player actively clicked. Autopilot decisions
// don't count. See incrementManualActions for the precise list of entry
// points that increment the counter.

import type { World } from "./types";
import { upgradeDef } from "./upgrades";

export const MILESTONES = {
  // Upgrade tier gates — markets won't actually stock these on shelves until
  // the player has racked up the required actions. Locked tiers are still
  // visible in the UI as placeholders so the player sees what's coming.
  upgradeTier1: 25,
  upgradeTier2: 150,
  upgradeTier3: 500,
  upgradeTier4: 900,
  // Crew offer gates — the hire board's role pool gets filtered by met
  // milestones, so a station never posts a navigator until the player has
  // earned it.
  navigatorOffers: 50,
  mechanicOffers:  100,
  captainOffers:   250,
  // Mercenaries are a Phase 2 combat unlock — they post after the player
  // has weathered enough manual play to have hit at least a few encounters
  // and feel the sting of running unarmed.
  mercenaryOffers: 350,
} as const;

export type MilestoneKey = keyof typeof MILESTONES;

export const MILESTONE_LABELS: Record<MilestoneKey, { label: string; description: string }> = {
  upgradeTier1:    { label: "Local Outfitters",   description: "Tier-1 modules appear in station markets." },
  upgradeTier2:    { label: "Refit Yards",        description: "Tier-2 modules appear in station markets." },
  upgradeTier3:    { label: "Specialist Yards",   description: "Tier-3 modules appear in station markets." },
  upgradeTier4:    { label: "Apex Foundries",     description: "Tier-4 endgame modules appear in markets." },
  navigatorOffers: { label: "Navigator's Guild",  description: "Stations post navigator offers — guidance hints unlock once one is hired." },
  mechanicOffers:  { label: "Mechanic's Guild",   description: "Stations post mechanic offers — keeps maintenance debt off your back." },
  captainOffers:   { label: "Pilot's Guild",      description: "Stations post captain offers — autopilot trading unlocks once one is hired." },
  mercenaryOffers: { label: "Mercenary Hall",     description: "Stations post mercenary offers — improves your odds in combat encounters." },
};

export function manualActions(world: World): number {
  return world.player?.manualActionCount ?? 0;
}

export function isMilestoneMet(world: World, key: MilestoneKey): boolean {
  return manualActions(world) >= MILESTONES[key];
}

// Increment the player's career action counter. Called only from manual
// entry points (player-initiated buy / sell / travel / refuel / accept-job
// / collect-job / install-upgrade / hire-crew / stock orders). Autopilot
// goes through different code paths (departForReposition, executeAutoLoadoutPlan)
// and never reaches these wrappers, so the counter naturally excludes auto
// actions without an explicit branch.
//
// Safe to call without a player set — quietly no-ops in NPC-only worlds
// (the audit test harness, scenario runs).
export function incrementManualActions(world: World, n: number = 1): void {
  if (!world.player) return;
  world.player.manualActionCount = (world.player.manualActionCount ?? 0) + n;
}

// Map an upgrade tier to its milestone key. Tiers are 1-4 in the catalog.
export function upgradeTierMilestone(tier: number): MilestoneKey | null {
  if (tier === 1) return "upgradeTier1";
  if (tier === 2) return "upgradeTier2";
  if (tier === 3) return "upgradeTier3";
  if (tier === 4) return "upgradeTier4";
  return null;
}

// Map a crew role to its milestone key.
export function crewRoleMilestone(role: import("./types").CrewRole): MilestoneKey {
  if (role === "captain")   return "captainOffers";
  if (role === "navigator") return "navigatorOffers";
  if (role === "mechanic")  return "mechanicOffers";
  return "mercenaryOffers";
}

export interface MilestoneProgress {
  key: MilestoneKey;
  current: number;
  target: number;
  met: boolean;
  label: string;
  description: string;
}

export function listMilestoneProgress(world: World): MilestoneProgress[] {
  const current = manualActions(world);
  return (Object.keys(MILESTONES) as MilestoneKey[]).map(key => ({
    key,
    current,
    target: MILESTONES[key],
    met: current >= MILESTONES[key],
    ...MILESTONE_LABELS[key],
  }));
}

// Test helper — fast-forward the milestone counter past every gate so tests
// can exercise upgrade installs / hire offers without manually driving the
// player through hundreds of actions. Also runs an immediate replenish so
// upgrade stocks land on shelves on the same tick the helper is called.
export function unlockAllMilestonesForTests(world: World): void {
  if (!world.player) return;
  const max = Math.max(...Object.values(MILESTONES));
  world.player.manualActionCount = max;
  replenishUnlockedUpgrades(world);
}

// Per-tick pass: for each station, for each milestone-gated upgrade in its
// targetStock list, seed initial stock once the tier milestone is met.
// market.upgradesUnlocked tracks per-(station, upgrade) whether the seed
// has been delivered, so once the player buys a one-shot upgrade the stock
// stays at 0 instead of being restocked next tick.
export function replenishUnlockedUpgrades(world: World): void {
  for (const loc of Object.values(world.locations)) {
    const market = world.markets[loc.id];
    if (!market) continue;
    const ts = loc.targetStock as Record<string, number>;
    for (const goodId of Object.keys(ts)) {
      if (!market.upgradesUnlocked) market.upgradesUnlocked = {};
      if (market.upgradesUnlocked[goodId]) continue;
      const def = upgradeDef(goodId);
      if (!def) continue;
      const tierKey = upgradeTierMilestone(def.tier);
      if (!tierKey || !isMilestoneMet(world, tierKey)) continue;
      const want = ts[goodId] ?? 0;
      if (want <= 0) continue;
      market.stock[goodId] = want;
      market.upgradesUnlocked[goodId] = true;
    }
  }
}
