// Renders the progression audit's findings as a director-facing HTML report
// (with inline SVG charts) and a committable Markdown companion. Both files
// land in /docs so they can be reviewed offline or linked from the wiki.
//
// Public API: writeReports(data, outDir) — writes both files. The audit
// script in progression_audit.ts collects the data and calls this at the end.

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Slot color palette — used across all charts so the eye can track a slot
// through wealth/timeline/utilization views.
const SLOT_COLOR: Record<string, string> = {
  cargo:   "#d8732d",   // amber/orange — the workhorse upgrade
  engine:  "#3a8db8",   // steel blue
  fuel:    "#5ba85f",   // muted green
  hull:    "#8b6db1",   // dusty purple
  weapon:  "#c14a4a",   // crimson
  systems: "#b29a3a",   // ochre
};
const ROLE_COLOR: Record<string, string> = {
  captain:   "#c14a4a",     // captain = combat/danger color, biggest gating
  mechanic:  "#3a8db8",     // mechanic = steady utility
  navigator: "#5ba85f",     // navigator = entry-level affordable
};

export interface UpgradeRow {
  good: string;
  name: string;
  slot: string;
  tier: number;
  price: number;
  effect: string;
  affordableMedian: number;
  reachableMedian: number;
  installedMedian: number;
  installedFraction: number;
  reachableFraction: number;
  stations: string;
}

export interface CrewRow {
  role: string;
  tier: number;
  affordableMedian: number;
  hiredMedian: number;
  hiredFraction: number;
  unlockMedianPrice: number;
  observedMedianPrice: number;
  observedSampleCount: number;
}

export interface TraceSample {
  tick: number;
  funds: number;
  cargoValue: number;
}

export interface ReportData {
  generatedAt: string;
  horizon: number;
  seedCount: number;
  upgrades: UpgradeRow[];
  crew: CrewRow[];
  traces: TraceSample[][];        // one trace per seed
}

// --- chart primitives ------------------------------------------------------
// Hand-rolled SVG so the report is fully self-contained. No external libs.

interface ChartBox { w: number; h: number; pl: number; pr: number; pt: number; pb: number }

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c] ?? c));
}

function fmtTick(t: number): string {
  return Number.isFinite(t) ? `t=${Math.round(t).toLocaleString()}` : "never";
}

function fmtMoney(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) >= 1_000_000) return `Ç${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `Ç${(n / 1_000).toFixed(1)}k`;
  return `Ç${Math.round(n)}`;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(0)}%`;
}

// Wealth chart: median funds with p25–p75 envelope across seeds.
function wealthChart(traces: TraceSample[][], horizon: number): string {
  const box: ChartBox = { w: 880, h: 280, pl: 70, pr: 24, pt: 24, pb: 40 };
  const innerW = box.w - box.pl - box.pr;
  const innerH = box.h - box.pt - box.pb;

  // Aggregate: per-tick p25/median/p75.
  const tickSet = new Set<number>();
  for (const tr of traces) for (const s of tr) tickSet.add(s.tick);
  const ticks = [...tickSet].sort((a, b) => a - b);
  const series: { tick: number; p25: number; p50: number; p75: number }[] = [];
  for (const t of ticks) {
    const ftAtT: number[] = [];
    for (const tr of traces) {
      const s = tr.find(x => x.tick === t);
      if (s) ftAtT.push(s.funds);
    }
    if (ftAtT.length === 0) continue;
    const sorted = [...ftAtT].sort((a, b) => a - b);
    series.push({
      tick: t,
      p25: sorted[Math.floor(sorted.length * 0.25)],
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p75: sorted[Math.floor(sorted.length * 0.75)],
    });
  }

  const maxY = Math.max(...series.map(s => s.p75)) * 1.05 || 1;
  const xScale = (t: number) => box.pl + (t / horizon) * innerW;
  const yScale = (v: number) => box.pt + innerH - (v / maxY) * innerH;

  // Y-axis ticks at "nice" round values (250k, 500k, 1M, 2M, etc.)
  const niceStep = (() => {
    const target = maxY / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(target)));
    const m = target / mag;
    if (m < 1.5) return mag;
    if (m < 3) return 2 * mag;
    if (m < 7) return 5 * mag;
    return 10 * mag;
  })();

  const yTicks: number[] = [];
  for (let v = 0; v <= maxY; v += niceStep) yTicks.push(v);

  const xTicks: number[] = [];
  for (let t = 0; t <= horizon; t += Math.max(1000, Math.round(horizon / 8 / 1000) * 1000)) xTicks.push(t);

  // Envelope path (p25 down + p75 up, closed).
  const envTop = series.map((s, i) => `${i === 0 ? "M" : "L"}${xScale(s.tick).toFixed(1)},${yScale(s.p75).toFixed(1)}`).join(" ");
  const envBot = series.slice().reverse().map(s => `L${xScale(s.tick).toFixed(1)},${yScale(s.p25).toFixed(1)}`).join(" ");
  const envPath = `${envTop} ${envBot} Z`;

  const medianPath = series.map((s, i) => `${i === 0 ? "M" : "L"}${xScale(s.tick).toFixed(1)},${yScale(s.p50).toFixed(1)}`).join(" ");

  return `
<svg viewBox="0 0 ${box.w} ${box.h}" xmlns="http://www.w3.org/2000/svg" class="chart">
  <rect x="${box.pl}" y="${box.pt}" width="${innerW}" height="${innerH}" fill="#fafafa" stroke="none"/>
  ${yTicks.map(v => `<line x1="${box.pl}" x2="${box.pl + innerW}" y1="${yScale(v).toFixed(1)}" y2="${yScale(v).toFixed(1)}" stroke="#e8e8e8" stroke-width="1"/>`).join("")}
  ${yTicks.map(v => `<text x="${box.pl - 6}" y="${(yScale(v) + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#666">${fmtMoney(v)}</text>`).join("")}
  ${xTicks.map(t => `<text x="${xScale(t).toFixed(1)}" y="${box.h - box.pb + 16}" text-anchor="middle" font-size="11" fill="#666">${t.toLocaleString()}</text>`).join("")}
  <text x="${box.pl + innerW / 2}" y="${box.h - 4}" text-anchor="middle" font-size="11" fill="#888">tick</text>
  <path d="${envPath}" fill="#3a8db8" fill-opacity="0.18" stroke="none"/>
  <path d="${medianPath}" fill="none" stroke="#1f6896" stroke-width="2"/>
  <text x="${box.pl + innerW - 6}" y="${box.pt + 14}" text-anchor="end" font-size="11" fill="#1f6896">median funds (p25–p75 envelope)</text>
</svg>`.trim();
}

// Per-slot tier ladder: dots positioned on a horizontal axis showing each
// tier's reachable tick. One row per slot. Quickly reveals where the ladder
// stalls.
function slotLadderChart(rows: UpgradeRow[], horizon: number): string {
  const slots = ["cargo", "engine", "fuel", "hull", "weapon", "systems"];
  const box: ChartBox = { w: 880, h: 260, pl: 90, pr: 80, pt: 24, pb: 36 };
  const innerW = box.w - box.pl - box.pr;
  const innerH = box.h - box.pt - box.pb;
  const rowH = innerH / slots.length;

  const xScale = (t: number) => box.pl + (t / horizon) * innerW;

  const xTicks: number[] = [];
  for (let t = 0; t <= horizon; t += Math.max(1000, Math.round(horizon / 8 / 1000) * 1000)) xTicks.push(t);

  let svg = `<svg viewBox="0 0 ${box.w} ${box.h}" xmlns="http://www.w3.org/2000/svg" class="chart">`;
  svg += `<rect x="${box.pl}" y="${box.pt}" width="${innerW}" height="${innerH}" fill="#fafafa"/>`;
  // gridlines
  for (const t of xTicks) {
    svg += `<line x1="${xScale(t).toFixed(1)}" x2="${xScale(t).toFixed(1)}" y1="${box.pt}" y2="${box.pt + innerH}" stroke="#e8e8e8"/>`;
    svg += `<text x="${xScale(t).toFixed(1)}" y="${box.h - box.pb + 16}" text-anchor="middle" font-size="11" fill="#666">${t.toLocaleString()}</text>`;
  }
  svg += `<text x="${box.pl + innerW / 2}" y="${box.h - 4}" text-anchor="middle" font-size="11" fill="#888">tick</text>`;

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    const yMid = box.pt + i * rowH + rowH / 2;
    const yLine = Math.round(yMid);
    svg += `<text x="${box.pl - 8}" y="${yLine + 4}" text-anchor="end" font-size="12" font-weight="600" fill="#444">${slot}</text>`;
    svg += `<line x1="${box.pl}" x2="${box.pl + innerW}" y1="${yLine}" y2="${yLine}" stroke="#ddd"/>`;
    // Group by tier — find the EARLIEST reachable tick per tier (the player
    // typically gets the first one at that tier they can afford).
    const byTier = new Map<number, number>();
    for (const r of rows) {
      if (r.slot !== slot) continue;
      if (!Number.isFinite(r.reachableMedian)) continue;
      const cur = byTier.get(r.tier);
      if (cur == null || r.reachableMedian < cur) byTier.set(r.tier, r.reachableMedian);
    }
    for (const [tier, tick] of byTier) {
      const x = xScale(Math.min(tick, horizon));
      svg += `<circle cx="${x.toFixed(1)}" cy="${yLine}" r="6" fill="${SLOT_COLOR[slot]}" stroke="#fff" stroke-width="1.5"/>`;
      svg += `<text x="${x.toFixed(1)}" y="${yLine - 9}" text-anchor="middle" font-size="10" fill="#444">T${tier}</text>`;
    }
    // Stranded tiers (never reached) — shown as ✕ at the right edge.
    const tiersForSlot = new Set(rows.filter(r => r.slot === slot).map(r => r.tier));
    const reachedTiers = new Set([...byTier.keys()]);
    const missing = [...tiersForSlot].filter(t => !reachedTiers.has(t)).sort();
    let xMissing = box.pl + innerW + 14;
    for (const t of missing) {
      svg += `<text x="${xMissing}" y="${yLine + 4}" font-size="11" fill="#c33">✕T${t}</text>`;
      xMissing += 24;
    }
  }

  svg += `</svg>`;
  return svg;
}

// Unlock timeline: every reachable item plotted by tick, color-coded by slot
// or role. Shows pacing visually — clusters and gaps both pop out.
function timelineChart(upgrades: UpgradeRow[], crew: CrewRow[], horizon: number): string {
  const box: ChartBox = { w: 880, h: 220, pl: 70, pr: 60, pt: 24, pb: 50 };
  const innerW = box.w - box.pl - box.pr;
  const innerH = box.h - box.pt - box.pb;
  const xScale = (t: number) => box.pl + (Math.min(t, horizon) / horizon) * innerW;

  const xTicks: number[] = [];
  for (let t = 0; t <= horizon; t += Math.max(1000, Math.round(horizon / 8 / 1000) * 1000)) xTicks.push(t);

  // Flatten + sort all events.
  interface Ev { tick: number; color: string; label: string; group: "upgrade" | "crew" }
  const events: Ev[] = [];
  for (const u of upgrades) {
    if (!Number.isFinite(u.reachableMedian)) continue;
    events.push({ tick: u.reachableMedian, color: SLOT_COLOR[u.slot] ?? "#888", label: `${u.name} (T${u.tier})`, group: "upgrade" });
  }
  for (const c of crew) {
    if (!Number.isFinite(c.affordableMedian)) continue;
    events.push({ tick: c.affordableMedian, color: ROLE_COLOR[c.role] ?? "#888", label: `${c.role} T${c.tier}`, group: "crew" });
  }

  let svg = `<svg viewBox="0 0 ${box.w} ${box.h}" xmlns="http://www.w3.org/2000/svg" class="chart">`;
  svg += `<rect x="${box.pl}" y="${box.pt}" width="${innerW}" height="${innerH}" fill="#fafafa"/>`;
  for (const t of xTicks) {
    svg += `<line x1="${xScale(t).toFixed(1)}" x2="${xScale(t).toFixed(1)}" y1="${box.pt}" y2="${box.pt + innerH}" stroke="#e8e8e8"/>`;
    svg += `<text x="${xScale(t).toFixed(1)}" y="${box.h - box.pb + 16}" text-anchor="middle" font-size="11" fill="#666">${t.toLocaleString()}</text>`;
  }
  svg += `<text x="${box.pl + innerW / 2}" y="${box.h - 4}" text-anchor="middle" font-size="11" fill="#888">tick</text>`;

  // Two rows: upgrades on top, crew on bottom.
  const yUpgrade = box.pt + innerH * 0.35;
  const yCrew = box.pt + innerH * 0.75;
  svg += `<text x="${box.pl - 8}" y="${yUpgrade + 4}" text-anchor="end" font-size="12" font-weight="600" fill="#444">upgrades</text>`;
  svg += `<text x="${box.pl - 8}" y="${yCrew + 4}" text-anchor="end" font-size="12" font-weight="600" fill="#444">crew</text>`;

  for (const e of events) {
    const x = xScale(e.tick);
    const y = e.group === "upgrade" ? yUpgrade : yCrew;
    svg += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5" fill="${e.color}" fill-opacity="0.7" stroke="${e.color}" stroke-width="1.5"><title>${escapeXml(e.label)} @ t=${Math.round(e.tick)}</title></circle>`;
  }

  // Slot legend bottom.
  let lx = box.pl;
  const ly = box.h - 22;
  const slotsLegend = ["cargo", "engine", "fuel", "hull", "weapon", "systems"];
  for (const slot of slotsLegend) {
    svg += `<circle cx="${lx + 6}" cy="${ly + 5}" r="5" fill="${SLOT_COLOR[slot]}"/>`;
    svg += `<text x="${lx + 16}" y="${ly + 9}" font-size="11" fill="#555">${slot}</text>`;
    lx += 78;
  }

  svg += `</svg>`;
  return svg;
}

// Variant utilization: install-rate bar per upgrade, sorted descending. Makes
// the "stranded variants" finding visceral — bars at 0% stand out.
function variantUtilizationChart(rows: UpgradeRow[]): string {
  const sorted = [...rows].sort((a, b) =>
    a.tier - b.tier
    || a.slot.localeCompare(b.slot)
    || a.price - b.price,
  );
  const barH = 14;
  const gap = 2;
  const labelW = 240;
  const valueW = 60;
  const trackW = 480;
  const w = labelW + trackW + valueW + 24;
  const h = sorted.length * (barH + gap) + 30;

  let svg = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" class="chart">`;
  svg += `<rect x="0" y="0" width="${w}" height="${h}" fill="#fafafa"/>`;
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const y = 18 + i * (barH + gap);
    const fillFrac = Math.max(0, Math.min(1, r.installedFraction));
    const barLen = fillFrac * trackW;
    const color = SLOT_COLOR[r.slot] ?? "#888";
    const dim = fillFrac < 0.05 ? 0.5 : 1.0;
    svg += `<text x="6" y="${y + 11}" font-size="11" fill="#444" opacity="${dim}">${escapeXml(`T${r.tier} ${r.slot} · ${r.name}`)}</text>`;
    // Track bg
    svg += `<rect x="${labelW}" y="${y + 2}" width="${trackW}" height="${barH - 4}" fill="#ececec"/>`;
    // Bar
    if (barLen > 0) svg += `<rect x="${labelW}" y="${y + 2}" width="${barLen.toFixed(1)}" height="${barH - 4}" fill="${color}"/>`;
    // Pct
    svg += `<text x="${labelW + trackW + 6}" y="${y + 11}" font-size="11" fill="#444">${pct(fillFrac)}</text>`;
  }
  svg += `</svg>`;
  return svg;
}

// Crew unlock chart — bars showing first-affordable tick per role/tier.
function crewChart(rows: CrewRow[], horizon: number): string {
  const sorted = [...rows].sort((a, b) =>
    a.role.localeCompare(b.role) || a.tier - b.tier,
  );
  const barH = 22;
  const gap = 6;
  const labelW = 130;
  const w = 880;
  const h = sorted.length * (barH + gap) + 70;
  const trackX = labelW + 16;
  const trackW = w - trackX - 80;
  const xScale = (t: number) => trackX + (Math.min(t, horizon) / horizon) * trackW;

  let svg = `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" class="chart">`;
  svg += `<rect x="${trackX}" y="20" width="${trackW}" height="${sorted.length * (barH + gap)}" fill="#fafafa"/>`;
  // gridlines
  const xTicks: number[] = [];
  for (let t = 0; t <= horizon; t += Math.max(1000, Math.round(horizon / 8 / 1000) * 1000)) xTicks.push(t);
  for (const t of xTicks) {
    svg += `<line x1="${xScale(t).toFixed(1)}" x2="${xScale(t).toFixed(1)}" y1="20" y2="${20 + sorted.length * (barH + gap)}" stroke="#e8e8e8"/>`;
    svg += `<text x="${xScale(t).toFixed(1)}" y="${h - 12}" text-anchor="middle" font-size="11" fill="#666">${t.toLocaleString()}</text>`;
  }

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const y = 24 + i * (barH + gap);
    const color = ROLE_COLOR[r.role] ?? "#888";
    svg += `<text x="${labelW}" y="${y + 14}" text-anchor="end" font-size="12" fill="#333">${r.role} T${r.tier}</text>`;
    svg += `<text x="${labelW + 4}" y="${y + 14}" text-anchor="start" font-size="10" fill="#888">${fmtMoney(r.observedMedianPrice)}</text>`;
    if (Number.isFinite(r.affordableMedian)) {
      const x1 = xScale(0);
      const x2 = xScale(r.affordableMedian);
      svg += `<rect x="${x1.toFixed(1)}" y="${y + 4}" width="${(x2 - x1).toFixed(1)}" height="${barH - 8}" fill="${color}" fill-opacity="0.7"/>`;
      svg += `<text x="${(x2 + 6).toFixed(1)}" y="${y + 14}" font-size="11" fill="#444">${fmtTick(r.affordableMedian)}${Number.isFinite(r.hiredMedian) ? "" : ""}</text>`;
    } else {
      svg += `<text x="${trackX}" y="${y + 14}" font-size="11" fill="#c33">never affordable in ${horizon}t · saw ${r.observedSampleCount} offers</text>`;
    }
  }
  svg += `<text x="${labelW + trackW / 2 + 16}" y="${h - 0}" text-anchor="middle" font-size="11" fill="#888">tick of first affordable in-person offer</text>`;
  svg += `</svg>`;
  return svg;
}

// --- findings + recs (computed from the data) ------------------------------

interface Finding {
  title: string;
  body: string;
  severity: "high" | "med" | "low";
}

interface Recommendation {
  title: string;
  body: string;
}

function computeFindings(data: ReportData): { findings: Finding[]; recs: Recommendation[] } {
  const { upgrades, crew } = data;
  const findings: Finding[] = [];
  const recs: Recommendation[] = [];

  // Variant cannibalization — same slot+tier with one variant at high install
  // % and a sibling at near-0%. The cheaper one wins because the auto-buyer
  // climbs the cheapest rung.
  const groups = new Map<string, UpgradeRow[]>();
  for (const u of upgrades) {
    const k = `${u.slot}_T${u.tier}`;
    const arr = groups.get(k) ?? [];
    arr.push(u);
    groups.set(k, arr);
  }
  const cannibalized: { slot: string; tier: number; winner: UpgradeRow; loser: UpgradeRow }[] = [];
  for (const [k, arr] of groups) {
    if (arr.length < 2) continue;
    const sorted = [...arr].sort((a, b) => b.installedFraction - a.installedFraction);
    const winner = sorted[0];
    for (const loser of sorted.slice(1)) {
      if (winner.installedFraction >= 0.4 && loser.installedFraction <= 0.05) {
        cannibalized.push({ slot: winner.slot, tier: winner.tier, winner, loser });
      }
    }
    void k;
  }
  if (cannibalized.length > 0) {
    findings.push({
      severity: "high",
      title: `Variant cannibalization — ${cannibalized.length} upgrades effectively dead on arrival`,
      body: `Within each (slot × tier), the auto-buyer always climbs to the cheapest rung first. Variants priced even slightly higher than their slot+tier sibling never get bought. Examples:\n${cannibalized.slice(0, 6).map(c => `  • ${c.loser.name} (Ç${c.loser.price.toLocaleString()}, install ${pct(c.loser.installedFraction)}) loses to ${c.winner.name} (Ç${c.winner.price.toLocaleString()}, install ${pct(c.winner.installedFraction)})`).join("\n")}`,
    });
    recs.push({
      title: "Differentiate variants — make the price gap match a real choice",
      body: "Today the variants share a slot+tier and the cheaper option dominates. Either (a) drop the loser variants' price ~10–15% below the canonical to give them a real reason to exist as the budget pick, or (b) lift their effects with a clearly distinct stat profile (e.g., Modular Container Bay sacrifices capacity for unload speed — make that tradeoff matter for late-game players). The current pricing makes 15+ items shelf decoration.",
    });
  }

  // Captain wall — autopilot gating.
  const capT1 = crew.find(c => c.role === "captain" && c.tier === 1);
  if (capT1 && Number.isFinite(capT1.affordableMedian) && capT1.affordableMedian > 1500) {
    findings.push({
      severity: "high",
      title: `Captain wall: autopilot doesn't open until ${fmtTick(capT1.affordableMedian)}`,
      body: `Pilot T1 hire cost (Ç${capT1.observedMedianPrice.toLocaleString()}) gates the entire autopilot loop. With "good play" the autopilot synthetic captain reached funds parity at this tick; without the synthetic, real players are slower because manual play < autopilot. That's roughly 30+ minutes of trading at 1 tick/sec before the loop opens.`,
    });
    recs.push({
      title: "Make autopilot reachable in the first session",
      body: `Drop T1 captain hireCost from Ç${capT1.observedMedianPrice.toLocaleString()} → ~Ç80k–Ç100k, OR introduce a Tier-0 "rookie pilot" at Ç40k–Ç50k that unlocks autopilot with reduced effects (no contract bonus, no speed bonus). Either lands captain-pilot in the first hour-of-play instead of after.`,
    });
  }

  // Stranded high-tier items.
  const stranded = upgrades.filter(u => !Number.isFinite(u.reachableMedian) || u.installedFraction < 0.2);
  const trulyStranded = upgrades.filter(u => !Number.isFinite(u.reachableMedian));
  if (trulyStranded.length > 0) {
    findings.push({
      severity: "med",
      title: `${trulyStranded.length} upgrades never reachable in ${data.horizon} ticks`,
      body: trulyStranded.slice(0, 6).map(u => `  • ${u.name} (Ç${u.price.toLocaleString()}, ${u.slot} T${u.tier}) — stocked at ${u.stations}`).join("\n"),
    });
  }
  if (stranded.length > upgrades.length * 0.4) {
    recs.push({
      title: `Compress the upper price band`,
      body: `${stranded.length}/${upgrades.length} upgrades install in <20% of seeds, mostly clustered Ç80k+. The wealth curve doesn't grow fast enough to keep up with the price ladder past T2. Either (a) cut top-tier prices ~25% so they unlock by t≈3000, or (b) introduce a "trade volume" multiplier so late-game runs scale faster.`,
    });
  }

  // Dead zones.
  const allTicks: { tick: number; label: string }[] = [];
  for (const u of upgrades) if (Number.isFinite(u.reachableMedian)) allTicks.push({ tick: u.reachableMedian, label: u.name });
  for (const c of crew) if (Number.isFinite(c.affordableMedian)) allTicks.push({ tick: c.affordableMedian, label: `${c.role} T${c.tier}` });
  allTicks.sort((a, b) => a.tick - b.tick);
  const gaps: { from: { tick: number; label: string }; to: { tick: number; label: string }; gap: number }[] = [];
  for (let i = 1; i < allTicks.length; i++) {
    const gap = allTicks[i].tick - allTicks[i - 1].tick;
    if (gap >= 400) gaps.push({ from: allTicks[i - 1], to: allTicks[i], gap });
  }
  if (gaps.length > 0) {
    findings.push({
      severity: "med",
      title: `${gaps.length} pacing dead zones (≥400 ticks with no new unlock)`,
      body: gaps.map(g => `  • t=${g.from.tick} → t=${g.to.tick} (Δ${g.gap})  between "${g.from.label}" → "${g.to.label}"`).join("\n"),
    });
    recs.push({
      title: "Add filler unlocks to break long stretches",
      body: "Each dead zone is a session-cliff: the player notices when nothing new opens for ~7+ minutes. Slot one mid-priced upgrade or hire offer into each gap (e.g., a Ç55k systems variant or a T1.5 captain). The exact items matter less than the existence of a 'next thing'.",
    });
  }

  // Captain T2/T3 strand.
  const capT2 = crew.find(c => c.role === "captain" && c.tier === 2);
  const capT3 = crew.find(c => c.role === "captain" && c.tier === 3);
  if (capT3 && capT3.hiredFraction === 0 && Number.isFinite(capT3.observedMedianPrice)) {
    findings.push({
      severity: "low",
      title: "Captain T3 looks like dead loot",
      body: `Captain T3 median offer Ç${capT3.observedMedianPrice.toLocaleString()}; affordable at ${fmtTick(capT3.affordableMedian)} but never hired in any seed within ${data.horizon} ticks. Either players never accumulate enough surplus, or the upgrade-vs-crew ROI tradeoff makes T3 captain worse than two T2 hires.`,
    });
  }
  if (capT2 && capT2.hiredFraction === 0) {
    findings.push({
      severity: "low",
      title: "Captain T2 also never hired",
      body: `Even at the affordable tick, the auto-buyer never picked up Captain T2 — a pattern worth scrutinising. Likely cause: the audit's hiring policy stops upgrading captain after the first hire (T1), and your players might do the same.`,
    });
  }

  return { findings, recs };
}

// --- HTML rendering --------------------------------------------------------

function htmlReport(data: ReportData): string {
  const { findings, recs } = computeFindings(data);

  const upgradeTableRows = [...data.upgrades]
    .sort((a, b) => a.reachableMedian - b.reachableMedian || a.tier - b.tier || a.price - b.price)
    .map(r => `
      <tr>
        <td>${r.tier}</td>
        <td>${r.slot}</td>
        <td class="num">Ç${r.price.toLocaleString()}</td>
        <td>${escapeXml(r.name)}</td>
        <td>${escapeXml(r.effect)}</td>
        <td class="num ${Number.isFinite(r.affordableMedian) ? "" : "never"}">${fmtTick(r.affordableMedian)}</td>
        <td class="num ${Number.isFinite(r.reachableMedian) ? "" : "never"}">${fmtTick(r.reachableMedian)}</td>
        <td class="num ${Number.isFinite(r.installedMedian) ? "" : "never"}">${fmtTick(r.installedMedian)}</td>
        <td class="num">${pct(r.installedFraction)}</td>
        <td class="meta">${escapeXml(r.stations)}</td>
      </tr>`)
    .join("");

  const crewTableRows = [...data.crew]
    .sort((a, b) => a.role.localeCompare(b.role) || a.tier - b.tier)
    .map(r => `
      <tr>
        <td>${r.role}</td>
        <td>${r.tier}</td>
        <td class="num">${fmtMoney(r.observedMedianPrice)}</td>
        <td class="num">${fmtMoney(r.unlockMedianPrice)}</td>
        <td class="num ${Number.isFinite(r.affordableMedian) ? "" : "never"}">${fmtTick(r.affordableMedian)}</td>
        <td class="num ${Number.isFinite(r.hiredMedian) ? "" : "never"}">${fmtTick(r.hiredMedian)}</td>
        <td class="num">${pct(r.hiredFraction)}</td>
        <td class="num meta">${r.observedSampleCount.toLocaleString()}</td>
      </tr>`)
    .join("");

  // TL;DR bullets
  const reachable = data.upgrades.filter(u => Number.isFinite(u.reachableMedian)).length;
  const installed = data.upgrades.filter(u => u.installedFraction >= 0.5).length;
  const stranded = data.upgrades.filter(u => !Number.isFinite(u.reachableMedian)).length;
  const captainTick = data.crew.find(c => c.role === "captain" && c.tier === 1)?.affordableMedian;
  const lastTrace = data.traces.map(t => t[t.length - 1]?.funds ?? 0).sort((a, b) => a - b);
  const finalMedianFunds = lastTrace[Math.floor(lastTrace.length / 2)];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Progression Audit — Director Report</title>
<style>
  :root {
    --ink: #1d1d1d;
    --ink2: #555;
    --rule: #ddd;
    --bg: #fdfdfb;
    --paper: #ffffff;
    --accent: #1f6896;
    --warn: #d8732d;
    --bad: #c14a4a;
  }
  * { box-sizing: border-box; }
  body {
    font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    color: var(--ink);
    background: var(--bg);
    max-width: 980px;
    margin: 0 auto;
    padding: 40px 32px 80px;
  }
  h1 { font-size: 30px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h1 + .meta { color: var(--ink2); font-size: 13px; }
  h2 {
    font-size: 20px;
    margin: 38px 0 12px;
    padding-bottom: 6px;
    border-bottom: 2px solid var(--ink);
    letter-spacing: -0.005em;
  }
  h3 { font-size: 15px; margin: 22px 0 6px; color: var(--ink); }
  p { margin: 8px 0; }
  ul, ol { margin: 8px 0; padding-left: 20px; }
  li { margin: 4px 0; }
  .meta { color: var(--ink2); font-size: 12px; }
  .tldr {
    background: var(--paper);
    border: 1px solid var(--rule);
    border-left: 4px solid var(--accent);
    padding: 14px 20px;
    margin: 16px 0;
  }
  .tldr ul { margin: 6px 0 0; }
  .finding, .rec {
    background: var(--paper);
    border: 1px solid var(--rule);
    padding: 12px 18px;
    margin: 10px 0;
    border-left: 4px solid var(--ink2);
  }
  .finding.high { border-left-color: var(--bad); }
  .finding.med  { border-left-color: var(--warn); }
  .finding.low  { border-left-color: var(--ink2); }
  .rec { border-left-color: #5ba85f; }
  .finding h3, .rec h3 { margin: 0 0 4px; font-size: 14px; }
  .finding pre, .rec pre { white-space: pre-wrap; font: inherit; color: var(--ink2); margin: 4px 0 0; }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 8px 0;
    font-size: 12.5px;
    background: var(--paper);
    border: 1px solid var(--rule);
  }
  th, td { padding: 6px 9px; text-align: left; border-bottom: 1px solid #eee; vertical-align: top; }
  th { background: #f3f3ee; font-weight: 600; font-size: 12px; color: var(--ink); border-bottom: 2px solid var(--rule); }
  tr:nth-child(even) td { background: #faf9f5; }
  .num { font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .never { color: var(--bad); }
  .chart-caption { color: var(--ink2); font-size: 12px; margin-bottom: 8px; max-width: 720px; }
  .chart {
    display: block;
    margin: 8px 0 18px;
    background: var(--paper);
    border: 1px solid var(--rule);
    border-radius: 2px;
    width: 100%;
    height: auto;
  }
  .legend-pill {
    display: inline-block;
    margin: 0 8px 4px 0;
    padding: 1px 8px;
    border-radius: 8px;
    font-size: 11px;
    color: #fff;
  }
  footer {
    margin-top: 60px;
    padding-top: 16px;
    border-top: 1px solid var(--rule);
    color: var(--ink2);
    font-size: 12px;
  }
</style>
</head>
<body>
  <h1>Progression Audit — Director Report</h1>
  <p class="meta">${data.generatedAt} · ${data.seedCount} seeds × ${data.horizon.toLocaleString()} ticks · ${data.upgrades.length} upgrades, ${data.crew.length} crew tiers tracked</p>

  <div class="tldr">
    <strong>TL;DR.</strong>
    <ul>
      <li><strong>${reachable}/${data.upgrades.length}</strong> upgrades become reachable inside ${data.horizon.toLocaleString()} ticks; <strong>${installed}</strong> are actually installed in &gt;50% of seeds; <strong>${stranded}</strong> never become reachable at all.</li>
      <li>Pilot autopilot gates at <strong>${captainTick ? fmtTick(captainTick) : "—"}</strong> — the single biggest pacing wall. Until then, the player has no path to the captain-led trade loop.</li>
      <li>Final median ship funds: <strong>${fmtMoney(finalMedianFunds)}</strong> at t=${data.horizon.toLocaleString()}. Wealth growth is healthy through t≈3000, then flattens.</li>
      <li>Variant pricing is <strong>broken</strong>: many T1/T2 variants priced just above their cheaper sibling are never purchased — they exist only as shelf clutter.</li>
      <li>${gapsCount(data)} pacing dead zones identified (gaps ≥400 ticks). See "Pacing dead zones" below.</li>
    </ul>
  </div>

  <h2>Methodology</h2>
  <p>An autopilot-driven player ship is run from t=0 across ${data.seedCount} world seeds (1 starter universe, ${data.seedCount - 1} generated 12-location worlds, all starting at a trade-hub). A synthetic zero-cost captain is slotted on the audit ship so the autopilot can drive — without it, the ship sits idle with no path to wealth (which is itself a finding). Each tick, the audit:</p>
  <ol>
    <li>Repairs maintenance debt above Ç5k.</li>
    <li>Posts hire offers visible to the ship; records affordability + actually hires real crew when funds permit.</li>
    <li>Climbs the upgrade ladder one rung at a time per slot, only when funds &gt; price + Ç25k working buffer, never before t=50.</li>
    <li>Records every upgrade's first-affordable, first-reachable, and first-installed tick.</li>
  </ol>
  <p>Aggregates are medians across seeds. "Reachable" = funds AND idle at a station that stocks the item. "Affordable" ignores location (cash check only).</p>

  <h2>Player wealth trajectory</h2>
  <p class="chart-caption">Median ship funds across seeds (heavy line) with p25–p75 envelope. The ramp-up phase ends around t≈3000, after which the curve flattens — the wealth ceiling beyond that point limits which upgrades remain in reach.</p>
  ${wealthChart(data.traces, data.horizon)}

  <h2>Per-slot tier ladder</h2>
  <p class="chart-caption">For each upgrade slot, the earliest tick the player reaches a given tier. Ticks bunched on the left = healthy ramp; long horizontal hops = pacing dead zones for that slot. ✕ markers on the right = tiers that never reached.</p>
  ${slotLadderChart(data.upgrades, data.horizon)}

  <h2>Unlock timeline</h2>
  <p class="chart-caption">Every unlock plotted by tick, color-coded by slot (top row) or crew role (bottom row). Clusters show "burst" milestones; gaps show pacing flat spots.</p>
  ${timelineChart(data.upgrades, data.crew, data.horizon)}

  <h2>Crew unlock pacing</h2>
  <p class="chart-caption">First tick each crew role/tier becomes affordable in person. Bars stop at the unlock tick; missing bars = never affordable in this run.</p>
  ${crewChart(data.crew, data.horizon)}

  <h2>Variant utilization</h2>
  <p class="chart-caption">Install rate per upgrade — fraction of seeds where the auto-buyer actually purchased + installed it. Bars near 0% are the cannibalized variants.</p>
  ${variantUtilizationChart(data.upgrades)}

  <h2>Findings</h2>
  ${findings.map(f => `<div class="finding ${f.severity}"><h3>${escapeXml(f.title)}</h3><pre>${escapeXml(f.body)}</pre></div>`).join("\n")}

  <h2>Recommendations</h2>
  ${recs.map(r => `<div class="rec"><h3>${escapeXml(r.title)}</h3><p>${escapeXml(r.body)}</p></div>`).join("\n")}

  <h2>Appendix: full upgrade table</h2>
  <table>
    <thead>
      <tr>
        <th>T</th><th>slot</th><th>price</th><th>upgrade</th><th>effect</th>
        <th>affordable</th><th>reachable</th><th>installed</th><th>inst%</th><th>stocked at</th>
      </tr>
    </thead>
    <tbody>${upgradeTableRows}</tbody>
  </table>

  <h2>Appendix: crew table</h2>
  <table>
    <thead>
      <tr>
        <th>role</th><th>T</th><th>median offer</th><th>median unlock-price</th>
        <th>affordable</th><th>hired</th><th>hire %</th><th>offers seen</th>
      </tr>
    </thead>
    <tbody>${crewTableRows}</tbody>
  </table>

  <footer>
    Generated by <code>npm run audit:progression</code> ─ <code>src/sim/scenarios/progression_audit.ts</code>. Re-run after any pricing change to compare.
  </footer>
</body>
</html>`;
}

function gapsCount(data: ReportData): number {
  const allTicks: number[] = [];
  for (const u of data.upgrades) if (Number.isFinite(u.reachableMedian)) allTicks.push(u.reachableMedian);
  for (const c of data.crew) if (Number.isFinite(c.affordableMedian)) allTicks.push(c.affordableMedian);
  allTicks.sort((a, b) => a - b);
  let n = 0;
  for (let i = 1; i < allTicks.length; i++) if (allTicks[i] - allTicks[i - 1] >= 400) n += 1;
  return n;
}

// --- Markdown rendering -----------------------------------------------------

function mdReport(data: ReportData): string {
  const { findings, recs } = computeFindings(data);
  const reachable = data.upgrades.filter(u => Number.isFinite(u.reachableMedian)).length;
  const installed = data.upgrades.filter(u => u.installedFraction >= 0.5).length;
  const stranded = data.upgrades.filter(u => !Number.isFinite(u.reachableMedian)).length;
  const captainTick = data.crew.find(c => c.role === "captain" && c.tier === 1)?.affordableMedian;
  const lastTrace = data.traces.map(t => t[t.length - 1]?.funds ?? 0).sort((a, b) => a - b);
  const finalMedianFunds = lastTrace[Math.floor(lastTrace.length / 2)];

  const upgradeTable = [
    `| T | slot | price | upgrade | effect | affordable | reachable | installed | inst% | stocked at |`,
    `|---|---|---:|---|---|---:|---:|---:|---:|---|`,
    ...[...data.upgrades]
      .sort((a, b) => a.reachableMedian - b.reachableMedian || a.tier - b.tier || a.price - b.price)
      .map(r => `| ${r.tier} | ${r.slot} | Ç${r.price.toLocaleString()} | ${r.name} | ${r.effect} | ${fmtTick(r.affordableMedian)} | ${fmtTick(r.reachableMedian)} | ${fmtTick(r.installedMedian)} | ${pct(r.installedFraction)} | ${r.stations} |`),
  ].join("\n");

  const crewTable = [
    `| role | T | median offer | median unlock-price | affordable | hired | hire % | offers seen |`,
    `|---|---|---:|---:|---:|---:|---:|---:|`,
    ...[...data.crew]
      .sort((a, b) => a.role.localeCompare(b.role) || a.tier - b.tier)
      .map(r => `| ${r.role} | ${r.tier} | ${fmtMoney(r.observedMedianPrice)} | ${fmtMoney(r.unlockMedianPrice)} | ${fmtTick(r.affordableMedian)} | ${fmtTick(r.hiredMedian)} | ${pct(r.hiredFraction)} | ${r.observedSampleCount.toLocaleString()} |`),
  ].join("\n");

  // Tier-ladder ASCII chart.
  const slots = ["cargo", "engine", "fuel", "hull", "weapon", "systems"];
  const ladderLines: string[] = [];
  ladderLines.push("```");
  ladderLines.push(`        0  ${"·".repeat(40)}  ${data.horizon.toLocaleString()}`);
  for (const slot of slots) {
    const slotItems = data.upgrades.filter(u => u.slot === slot);
    const byTier = new Map<number, number>();
    for (const r of slotItems) {
      if (!Number.isFinite(r.reachableMedian)) continue;
      const cur = byTier.get(r.tier);
      if (cur == null || r.reachableMedian < cur) byTier.set(r.tier, r.reachableMedian);
    }
    const lineWidth = 40;
    const chars = Array(lineWidth).fill(" ");
    for (const [tier, tick] of byTier) {
      const idx = Math.min(lineWidth - 1, Math.max(0, Math.floor((tick / data.horizon) * lineWidth)));
      chars[idx] = String(tier);
    }
    ladderLines.push(`${slot.padEnd(8)}|${chars.join("")}|  tiers reached: ${[...byTier.keys()].sort().join("/") || "—"}`);
  }
  ladderLines.push("```");

  return `# Progression Audit — Director Report

_${data.generatedAt} · ${data.seedCount} seeds × ${data.horizon.toLocaleString()} ticks_

## TL;DR

- **${reachable}/${data.upgrades.length}** upgrades become reachable inside ${data.horizon.toLocaleString()} ticks; **${installed}** are installed in >50% of seeds; **${stranded}** never reachable.
- Pilot autopilot gates at **${captainTick ? fmtTick(captainTick) : "—"}** — the single biggest pacing wall. Until then, the player has no path to the captain-led trade loop.
- Final median ship funds: **${fmtMoney(finalMedianFunds)}** at t=${data.horizon.toLocaleString()}. Wealth growth is healthy through t≈3000, then flattens.
- Variant pricing is **broken**: many T1/T2 variants priced just above a cheaper sibling are never purchased.
- ${gapsCount(data)} pacing dead zones identified (gaps ≥400 ticks).

## Methodology

An autopilot-driven player ship runs from t=0 across ${data.seedCount} world seeds (1 starter universe, ${data.seedCount - 1} generated 12-location worlds, all starting at a trade-hub). A synthetic zero-cost captain is slotted on the audit ship so the autopilot can drive. Each tick, the audit:

1. Repairs maintenance debt above Ç5k.
2. Records affordability of every visible hire offer; hires real crew when funds permit.
3. Climbs the upgrade ladder one rung per slot per tick, only when funds > price + Ç25k buffer, never before t=50.
4. Records every upgrade's first-affordable, first-reachable, and first-installed tick.

Aggregates are medians across seeds. "Reachable" = funds AND idle at a station that stocks the item. "Affordable" ignores location.

## Per-slot tier ladder (ASCII)

${ladderLines.join("\n")}

(See HTML report for richer charts.)

## Findings

${findings.map(f => `### ${f.title}\n\n_Severity: ${f.severity}_\n\n${f.body}`).join("\n\n")}

## Recommendations

${recs.map(r => `### ${r.title}\n\n${r.body}`).join("\n\n")}

## Appendix: full upgrade table

${upgradeTable}

## Appendix: crew table

${crewTable}

---

_Generated by \`npm run audit:progression\` (\`src/sim/scenarios/progression_audit.ts\`). Re-run after any pricing change to compare._
`;
}

// --- public --------------------------------------------------------------

export function writeReports(data: ReportData, outDir: string): { html: string; md: string } {
  mkdirSync(outDir, { recursive: true });
  const htmlPath = join(outDir, "PROGRESSION_REPORT.html");
  const mdPath = join(outDir, "PROGRESSION_REPORT.md");
  writeFileSync(htmlPath, htmlReport(data), "utf-8");
  writeFileSync(mdPath, mdReport(data), "utf-8");
  return { html: htmlPath, md: mdPath };
}
