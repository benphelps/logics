// Per-syndicate control breakdown bar — shared between the atlas
// detail panel (LocationsView) and the fleet station-info card
// (PlayerView). Two modes:
//
//   1) Active challenge — when world.controlChallenge[locId] exists,
//      the station is in the middle of a transfer-battle. Renders a
//      head-to-head split between the current owner and the rival who
//      just took the lead. Width tracks ticksHeld / FLIP_HOLD_TICKS,
//      with a mild pow(0.7) amplification so early ticks read as
//      visible movement instead of an invisible 1/30 sliver.
//
//   2) Stable — render the full multi-syndicate breakdown as a single
//      horizontal bar. Hidden when only the dominant faction has any
//      meaningful presence; the faction tag already conveys that.
//
// The CSS lives in LocationsView.css under the .atlas-control-bar
// selector — both views import that stylesheet so this stays
// presentation-stable across consumers.

import type { CSSProperties } from "react";
import type { LocationId, World } from "../../sim/types";
import { FLIP_HOLD_TICKS } from "../../sim/control";

export function ControlShareBar({ world, locId }: { world: World; locId: LocationId }) {
  const ctrl = world.control?.[locId];
  if (!ctrl) return null;
  const challenge = world.controlChallenge?.[locId];
  if (challenge) {
    const ownerId = world.locations[locId]?.traits.faction;
    if (!ownerId) return null;
    const owner = world.syndicates[ownerId];
    const challenger = world.syndicates[challenge.syndicateId];
    if (!owner || !challenger || owner.id === challenger.id) return null;
    const raw = Math.min(1, Math.max(0, challenge.ticksHeld / FLIP_HOLD_TICKS));
    const visual = Math.pow(raw, 0.7);
    const ownerWidth = Math.max(0.04, 1 - visual);
    const challengerWidth = Math.max(0.04, visual);
    const ownerAccent = owner.accentHex ?? "#9bb6c8";
    const challengerAccent = challenger.accentHex ?? "#9bb6c8";
    return (
      <div
        className="atlas-control-bar contested"
        role="img"
        aria-label={`Contested: ${challenger.name} ${challenge.ticksHeld}/${FLIP_HOLD_TICKS} ticks`}
        title={`${owner.name} defending vs ${challenger.name} — ${challenge.ticksHeld}/${FLIP_HOLD_TICKS}`}
      >
        <div
          className="atlas-control-bar-segment owner"
          style={{ flexGrow: ownerWidth, backgroundColor: ownerAccent } as CSSProperties}
        >
          <span className="atlas-control-bar-label">{owner.name}</span>
        </div>
        <div
          className="atlas-control-bar-segment challenger"
          style={{ flexGrow: challengerWidth, backgroundColor: challengerAccent } as CSSProperties}
        >
          <span className="atlas-control-bar-label">{challenge.ticksHeld}/{FLIP_HOLD_TICKS}</span>
        </div>
      </div>
    );
  }
  const entries = Object.entries(ctrl)
    .filter(([, share]) => share >= 0.02)
    .sort((a, b) => b[1] - a[1]);
  if (entries.length < 2) return null;
  return (
    <div className="atlas-control-bar" role="img" aria-label="Syndicate control breakdown">
      {entries.map(([syndId, share], i) => {
        const synd = world.syndicates[syndId];
        const accent = synd?.accentHex ?? "#9bb6c8";
        const pct = Math.round(share * 100);
        const showLabel = i < 2;
        return (
          <div
            key={syndId}
            className="atlas-control-bar-segment"
            style={{ flexGrow: share, backgroundColor: accent } as CSSProperties}
            title={`${synd?.name ?? syndId} ${pct}%`}
          >
            {showLabel && <span className="atlas-control-bar-label">{pct}%</span>}
          </div>
        );
      })}
    </div>
  );
}
