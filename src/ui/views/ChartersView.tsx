// Charters view — two side-by-side panels within the standard page bounds:
//
//   Left (wider): tabbed milestone badges (Crew Guilds | Tier Licenses).
//     Carded grid because each entry is literally a badge — rarity colors
//     + EARNED stamps live here.
//
//   Right (narrower): the captain's ledger sidebar — flat ship-info-style
//     stat sections (career, wallet/fleet, activity placeholders, save
//     info). No table here; progress already lives on the badges panel.

import { useState, type CSSProperties } from "react";
import type { IconType } from "react-icons";
import {
  GiAstronautHelmet,
  GiAutoRepair,
  GiCargoCrate,
  GiCrossedSwords,
  GiFactory,
  GiPathDistance,
  GiProcessor,
} from "react-icons/gi";
import { useStore } from "../store";
import { listMilestoneProgress, type MilestoneKey, type MilestoneProgress } from "../../sim/milestones";
import { headerArtUrl } from "../art";
import "./ChartersView.css";

const MILESTONE_ICONS: Record<MilestoneKey, IconType> = {
  upgradeTier1:    GiCargoCrate,
  upgradeTier2:    GiFactory,
  upgradeTier3:    GiProcessor,
  upgradeTier4:    GiCrossedSwords,
  navigatorOffers: GiPathDistance,
  mechanicOffers:  GiAutoRepair,
  captainOffers:   GiAstronautHelmet,
};

function milestoneRarity(key: MilestoneKey): "common" | "uncommon" | "rare" | "legendary" {
  if (key === "upgradeTier1") return "common";
  if (key === "upgradeTier2" || key === "navigatorOffers" || key === "mechanicOffers") return "uncommon";
  if (key === "upgradeTier3" || key === "captainOffers") return "rare";
  return "legendary";
}

function milestoneCategory(key: MilestoneKey): "license" | "guild" {
  return key.startsWith("upgrade") ? "license" : "guild";
}

type ChartersTab = "guilds" | "licenses";

function artCardStyle(url: string): CSSProperties {
  return { "--card-art": `url("${url}")` } as CSSProperties;
}

export function ChartersView() {
  const world = useStore((s) => s.world);
  useStore((s) => s.tickEpoch);

  const [activeTab, setActiveTab] = useState<ChartersTab>("guilds");

  const progress = listMilestoneProgress(world);
  const earned = progress.filter(p => p.met).length;
  const total = progress.length;
  const totalActions = world.player?.manualActionCount ?? 0;

  const guilds = progress.filter(p => milestoneCategory(p.key) === "guild");
  const licenses = progress.filter(p => milestoneCategory(p.key) === "license");
  const activeRows = activeTab === "guilds" ? guilds : licenses;
  const activeEarned = activeRows.filter(p => p.met).length;

  const next = progress
    .filter(p => !p.met)
    .sort((a, b) => (a.target - a.current) - (b.target - b.current))[0] ?? null;

  const badgesArt = activeTab === "guilds"
    ? headerArtUrl("crewMarket")
    : headerArtUrl("shipyardUpgrades");

  return (
    <section className="charters-view">
      {/* Left (wider): tabbed badges — carded grid keeps the rarity colors
          and earned-stamp design language used on actual badges. */}
      <section className="charters-badges-card">
        <div className="bridge-card-tabs charters-badges-tabs">
          <button
            type="button"
            className={`bridge-tab ${activeTab === "guilds" ? "active" : ""}`}
            onClick={() => setActiveTab("guilds")}
          >
            Crew Guilds <span className="bridge-tab-count">{guilds.filter(p => p.met).length}/{guilds.length}</span>
          </button>
          <button
            type="button"
            className={`bridge-tab ${activeTab === "licenses" ? "active" : ""}`}
            onClick={() => setActiveTab("licenses")}
          >
            Tier Licenses <span className="bridge-tab-count">{licenses.filter(p => p.met).length}/{licenses.length}</span>
          </button>
        </div>
        <div
          className="charters-badges-head"
          style={artCardStyle(badgesArt)}
        >
          <div className="charters-badges-head-main">
            <span className="charters-badges-eyebrow">{activeTab === "guilds" ? "Service guild charters" : "Shipyard tier licenses"}</span>
            <span className="charters-badges-name">
              {activeTab === "guilds" ? "Crew Guilds" : "Tier Licenses"}
            </span>
          </div>
          <div className="charters-badges-head-stat">
            <span className="charters-badges-head-stat-num mono">{activeEarned}<span className="charters-badges-head-stat-sep">/</span>{activeRows.length}</span>
            <span className="charters-badges-head-stat-label">earned</span>
          </div>
        </div>
        <div className="charters-badges-body" data-scroll-key={`charters:badges:${activeTab}`}>
          <div className="charters-badges-grid">
            {activeRows.map(m => <MilestoneBadge key={m.key} progress={m} />)}
          </div>
        </div>
      </section>

      {/* Right (narrower): player info panel — career stats, wallet/fleet
          totals, placeholder metrics for things we'll wire to real data
          later, and save info. No charter table — the badges panel on the
          left already shows progress. */}
      <CaptainsLedgerSidebar
        world={world}
        totalActions={totalActions}
        earned={earned}
        total={total}
        next={next}
      />
    </section>
  );
}

// --- right-side player info panel -------------------------------------

interface SidebarProps {
  world: ReturnType<typeof useStore.getState>["world"];
  totalActions: number;
  earned: number;
  total: number;
  next: MilestoneProgress | null;
}

function CaptainsLedgerSidebar({ world, totalActions, earned, total, next }: SidebarProps) {
  const gameName = useStore((s) => s.gameName);
  const gameKind = useStore((s) => s.gameKind);

  const ships = world.player?.shipIds.map(id => world.traders[id]).filter(Boolean) ?? [];
  const wallet = ships.reduce((sum, s) => sum + (s?.funds ?? 0), 0);
  const flagship = ships[0];
  const ledgerArt = headerArtUrl("tradeLedger");

  // Markup mirrors ShipInfoPanelContent on the fleet view, plus an art-panel-head
  // splash above the body (same pattern stocks/markets/atlas use):
  //   .bridge-card .info-area-card wrapper
  //   .info-panel-frame column flex
  //   .charters-ledger-head .art-panel-head with art splash + title + pill
  //   .info-panel-fixed for the chip row beneath the splash
  //   .info-panel-scroll for the stat grid + sections
  return (
    <section className="bridge-card info-area-card charters-sidebar-card">
      <div className="info-panel-frame">
        <div
          className="charters-ledger-head art-panel-head"
          style={artCardStyle(ledgerArt)}
        >
          <div className="charters-ledger-head-main">
            <span className="charters-ledger-eyebrow">Career Progress</span>
            <span className="charters-ledger-name">Captain's Ledger</span>
          </div>
          <span className="station-kind-pill station-kind-frontier">
            {gameKind === "developer" ? "developer" : "standard"}
          </span>
        </div>

        <div className="info-panel-fixed">
          <div className="trade-helper-meta station-info-tags">
            <span>{flagship?.name ?? "No flagship"}</span>
            <span>{gameName}</span>
            <span>tick {world.tick.toLocaleString()}</span>
          </div>
        </div>

        <div className="info-panel-scroll" data-scroll-key="charters:ledger">
          <dl className="trade-helper-grid station-info-grid">
            <Stat label="manual actions" value={totalActions.toLocaleString()} />
            <Stat label="charters" value={`${earned} / ${total}`} />
            <Stat label="next at" value={next ? next.target.toLocaleString() : "—"} />
            <Stat label="wallet" value={`Ç${Math.round(wallet).toLocaleString()}`} />
            <Stat label="ships" value={ships.length.toString()} />
            <Stat label="time played" value="—" />
          </dl>

          <div className="trade-helper-section">
            <div className="exchange-section-title">Activity</div>
            <div className="trade-helper-line muted">
              <span>Trades completed</span><span className="mono">—</span>
            </div>
            <div className="trade-helper-line muted">
              <span>Contracts completed</span><span className="mono">—</span>
            </div>
            <div className="trade-helper-line muted">
              <span>Distance traveled</span><span className="mono">—</span>
            </div>
            <div className="trade-helper-line muted">
              <span>Stations visited</span><span className="mono">—</span>
            </div>
          </div>

          <div className="trade-helper-section">
            <div className="exchange-section-title">Recruitment</div>
            <div className="trade-helper-line muted">
              <span>Crew hired</span><span className="mono">—</span>
            </div>
            <div className="trade-helper-line muted">
              <span>Upgrades installed</span><span className="mono">—</span>
            </div>
          </div>

          <div className="trade-helper-section">
            <div className="exchange-section-title">Treasury</div>
            <div className="trade-helper-line muted">
              <span>Net worth</span><span className="mono">—</span>
            </div>
            <div className="trade-helper-line muted">
              <span>Cash flow / tick</span><span className="mono">—</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// Mirrors the Stat helper in PlayerView.tsx so the dl items render with the
// same .cargo-stat / .info-value class hooks.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="cargo-stat">
      <dt className="dim">{label}</dt>
      <dd key={value} className="mono info-value">{value}</dd>
    </div>
  );
}

// --- top-panel charter card (badge style — keeps rarity colors here only)

function MilestoneBadge({ progress }: { progress: MilestoneProgress }) {
  const Icon = MILESTONE_ICONS[progress.key];
  const fillPct = Math.min(100, (progress.current / Math.max(1, progress.target)) * 100);
  const remaining = Math.max(0, progress.target - progress.current);
  const rarity = milestoneRarity(progress.key);
  return (
    <div className={`milestone-badge rarity-${rarity} ${progress.met ? "earned" : "locked"}`}>
      <div className="milestone-emblem" aria-hidden="true">
        <Icon className="milestone-emblem-icon" />
        {progress.met && <span className="milestone-stamp">EARNED</span>}
      </div>
      <div className="milestone-body">
        <div className="milestone-name">{progress.label}</div>
        <div className="milestone-desc">{progress.description}</div>
        {progress.met ? (
          <div className="milestone-bar-row">
            <span className="milestone-state-met">UNLOCKED</span>
            <span className="milestone-target-cap">at {progress.target.toLocaleString()} actions</span>
          </div>
        ) : (
          <div className="milestone-bar-row">
            <div className="milestone-bar">
              <div className="milestone-bar-fill" style={{ width: `${fillPct.toFixed(1)}%` }} />
            </div>
            <span className="milestone-bar-text">
              <span className="milestone-bar-curr">{progress.current.toLocaleString()}</span>
              <span className="milestone-bar-sep">/</span>
              <span className="milestone-bar-target">{progress.target.toLocaleString()}</span>
              <span className="milestone-bar-remaining">−{remaining.toLocaleString()}</span>
            </span>
          </div>
        )}
      </div>
    </div>
  );
}
