import type { SyndicateId } from "../../sim/types";

// One station's contribution to its syndicate's influence field. x/y are
// in the same coordinate space the field will be sampled in (post
// projection — i.e. atlas/SVG coordinates, not raw world coords). Control
// is 0..1; v1 always passes 1.0, but Phase 3's dynamic control system
// will start swinging it on per-station basis.
export interface ControlSource {
  x: number;
  y: number;
  syndicateId: SyndicateId;
  control: number;
}

export interface ControlBoundary {
  syndicateId: SyndicateId;
  // SVG path string covering all closed loops of the syndicate's
  // territory. Multiple loops are concatenated; each loop ends with "Z"
  // so consumers using fill-rule="evenodd" get correct hole behaviour.
  pathD: string;
}

// Hex → rgb tuple. Forgiving — anything that doesn't parse falls back to
// neutral grey instead of throwing. Kept exported because the legacy
// canvas-fill renderer (and any future consumer that wants raw colour
// channels) still uses it.
export function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "").match(/^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  if (!m) return [200, 210, 220];
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

// Tuning constants. Inverse-square falloff with a small noise floor so
// the contribution stays finite at the station itself; the threshold
// keeps deep empty space from getting tinted by every station's weak
// tail. Same numbers the canvas-fill renderer used — chosen so a lone
// station's reach extends ~1/3 of typical inter-station spacing before
// fading out, and clusters merge into shared territory naturally.
const NOISE_FLOOR = 1;
const MIN_SUM = 0.0008;

interface DominantField {
  // Categorical map of which syndicate is dominant at each lattice
  // corner. Index = syndicate position in the syndicateIds array passed
  // to sampleDominantField; -1 means no syndicate is above the floor.
  dominant: Int16Array;
  // Per-(corner, syndicate) influence sum, flat-laid as
  // strengths[cornerIdx * numSyndicates + syndIdx]. Used by the
  // marching-squares interpolator to find the exact subpixel crossing
  // where one syndicate's territory hands off to the next, rather than
  // snapping to cell-edge midpoints (which is what produces the
  // stairstep jaggies on the rendered boundary).
  strengths: Float32Array;
  numSyndicates: number;
  cornersW: number;
  cornersH: number;
  cellW: number;
  cellH: number;
}

// Sample the dominant-syndicate field on a (gridW+1) × (gridH+1) corner
// lattice. The outer ring is forced to -1 ("no syndicate") so marching
// squares' loops always close cleanly inside the grid; territory that
// would naturally extend further just clips at the grid edge.
function sampleDominantField(
  sources: ControlSource[],
  syndicateIds: SyndicateId[],
  width: number,
  height: number,
  gridW: number,
  gridH: number,
): DominantField {
  const cellW = width / gridW;
  const cellH = height / gridH;
  const cornersW = gridW + 1;
  const cornersH = gridH + 1;
  const numSyndicates = syndicateIds.length;
  const dominant = new Int16Array(cornersW * cornersH);
  const strengths = new Float32Array(cornersW * cornersH * numSyndicates);

  const idxOfSynd = new Map<SyndicateId, number>();
  for (let i = 0; i < numSyndicates; i++) idxOfSynd.set(syndicateIds[i], i);

  // Group sources by syndicate index for the per-cell hot loop.
  const bySynd: ControlSource[][] = syndicateIds.map(() => []);
  for (const s of sources) {
    const idx = idxOfSynd.get(s.syndicateId);
    if (idx != null) bySynd[idx].push(s);
  }

  for (let cy = 0; cy < cornersH; cy++) {
    const py = cy * cellH;
    const rowEdge = cy === 0 || cy === cornersH - 1;
    for (let cx = 0; cx < cornersW; cx++) {
      const off = cy * cornersW + cx;
      if (rowEdge || cx === 0 || cx === cornersW - 1) {
        // Force the boundary to "no syndicate" so marching squares can
        // close loops without special edge handling. Strengths stay 0
        // here — the interpolator's MIN_SUM fallback kicks in when an
        // edge crosses into the padded ring.
        dominant[off] = -1;
        continue;
      }
      const px = cx * cellW;
      const stOff = off * numSyndicates;
      let bestIdx = -1;
      let bestSum = 0;
      for (let i = 0; i < numSyndicates; i++) {
        const list = bySynd[i];
        let s = 0;
        for (let k = 0; k < list.length; k++) {
          const st = list[k];
          const dx = st.x - px;
          const dy = st.y - py;
          s += st.control / (dx * dx + dy * dy + NOISE_FLOOR);
        }
        strengths[stOff + i] = s;
        if (s > bestSum) { bestSum = s; bestIdx = i; }
      }
      dominant[off] = (bestIdx >= 0 && bestSum >= MIN_SUM) ? bestIdx : -1;
    }
  }

  return { dominant, strengths, numSyndicates, cornersW, cornersH, cellW, cellH };
}

// Compute the parametric position [0..1] along an edge (c1 → c2) where
// the boundary of `syndIdx`'s territory crosses. The crossing is the
// zero of the margin function: at each endpoint, margin = strength of
// `syndIdx` minus the strength of its strongest rival on the "out" side.
// Linear interpolation between the two margins finds where the line
// crosses zero — the exact subpixel handover point, which is what
// removes the cell-edge-midpoint stairstepping on the rendered border.
//
// When the rival is -1 (no syndicate at that corner), we fall back to
// the absolute strength threshold (MIN_SUM) so the boundary tapers out
// at the same place the territory was deemed to start.
function edgeFraction(
  field: DominantField,
  c1Idx: number,
  c2Idx: number,
  syndIdx: number,
): number {
  const { strengths, numSyndicates, dominant } = field;
  const c1In = dominant[c1Idx] === syndIdx;
  const c2In = dominant[c2Idx] === syndIdx;
  if (c1In === c2In) return 0.5; // caller guarantees a transition; defensive fallback

  // The "out" corner picks the comparison rival. Symmetric: whichever
  // corner is out, its dominant sets the strength we measure against.
  const outDom = c1In ? dominant[c2Idx] : dominant[c1Idx];
  const c1Off = c1Idx * numSyndicates;
  const c2Off = c2Idx * numSyndicates;
  let m1: number, m2: number;
  if (outDom === -1) {
    m1 = strengths[c1Off + syndIdx] - MIN_SUM;
    m2 = strengths[c2Off + syndIdx] - MIN_SUM;
  } else {
    m1 = strengths[c1Off + syndIdx] - strengths[c1Off + outDom];
    m2 = strengths[c2Off + syndIdx] - strengths[c2Off + outDom];
  }
  const denom = m1 - m2;
  if (Math.abs(denom) < 1e-9) return 0.5;
  const t = m1 / denom;
  // Clamp away from the exact corners — keeps the path string from
  // collapsing degenerate-length segments at junctions where three
  // territories meet.
  if (t < 0.005) return 0.005;
  if (t > 0.995) return 0.995;
  return t;
}

interface Segment {
  ax: number; ay: number;
  bx: number; by: number;
}

// Marching squares for one syndicate's binary mask (in/out per corner).
// Each cell's 4 corners give a 4-bit code → up to 2 line segments. Edge
// endpoints are interpolated to the actual zero-crossing of the margin
// field via edgeFraction(), so the boundary follows the precise subpixel
// handover between syndicates instead of snapping to cell-edge
// midpoints. That swap is what removes the stairstep jaggies — a coarse
// grid plus subpixel crossings reads visibly smoother than a much
// denser grid with midpoint snapping.
//
// Saddle cases (5, 10) split into two segments using the configuration
// that keeps connected regions connected; the alternative is rare and
// indistinguishable after smoothing.
function extractSegments(
  field: DominantField,
  syndicateIdx: number,
): Segment[] {
  const { dominant, cornersW, cornersH, cellW, cellH } = field;
  const gridW = cornersW - 1;
  const gridH = cornersH - 1;
  const segments: Segment[] = [];

  for (let j = 0; j < gridH; j++) {
    const yTop = j * cellH;
    const yBot = yTop + cellH;
    const rowOff = j * cornersW;
    const rowOffNext = (j + 1) * cornersW;
    for (let i = 0; i < gridW; i++) {
      const idxNW = rowOff + i;
      const idxNE = rowOff + i + 1;
      const idxSE = rowOffNext + i + 1;
      const idxSW = rowOffNext + i;
      const tl = dominant[idxNW] === syndicateIdx ? 1 : 0;
      const tr = dominant[idxNE] === syndicateIdx ? 1 : 0;
      const br = dominant[idxSE] === syndicateIdx ? 1 : 0;
      const bl = dominant[idxSW] === syndicateIdx ? 1 : 0;
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;

      const xLeft = i * cellW;
      const xRight = xLeft + cellW;

      // Subpixel-accurate crossings on each transition edge. Edges
      // with no transition keep a midpoint placeholder — they're never
      // referenced for the matching cases below.
      const nFrac = (tl !== tr) ? edgeFraction(field, idxNW, idxNE, syndicateIdx) : 0.5;
      const eFrac = (tr !== br) ? edgeFraction(field, idxNE, idxSE, syndicateIdx) : 0.5;
      const sFrac = (bl !== br) ? edgeFraction(field, idxSW, idxSE, syndicateIdx) : 0.5;
      const wFrac = (tl !== bl) ? edgeFraction(field, idxNW, idxSW, syndicateIdx) : 0.5;
      const N = { x: xLeft + nFrac * cellW, y: yTop };
      const E = { x: xRight,                y: yTop + eFrac * cellH };
      const S = { x: xLeft + sFrac * cellW, y: yBot };
      const W = { x: xLeft,                 y: yTop + wFrac * cellH };

      switch (code) {
        case 1:  segments.push({ ax: W.x, ay: W.y, bx: S.x, by: S.y }); break;
        case 2:  segments.push({ ax: S.x, ay: S.y, bx: E.x, by: E.y }); break;
        case 3:  segments.push({ ax: W.x, ay: W.y, bx: E.x, by: E.y }); break;
        case 4:  segments.push({ ax: E.x, ay: E.y, bx: N.x, by: N.y }); break;
        case 5:
          segments.push({ ax: W.x, ay: W.y, bx: N.x, by: N.y });
          segments.push({ ax: E.x, ay: E.y, bx: S.x, by: S.y });
          break;
        case 6:  segments.push({ ax: S.x, ay: S.y, bx: N.x, by: N.y }); break;
        case 7:  segments.push({ ax: W.x, ay: W.y, bx: N.x, by: N.y }); break;
        case 8:  segments.push({ ax: N.x, ay: N.y, bx: W.x, by: W.y }); break;
        case 9:  segments.push({ ax: N.x, ay: N.y, bx: S.x, by: S.y }); break;
        case 10:
          segments.push({ ax: N.x, ay: N.y, bx: E.x, by: E.y });
          segments.push({ ax: S.x, ay: S.y, bx: W.x, by: W.y });
          break;
        case 11: segments.push({ ax: N.x, ay: N.y, bx: E.x, by: E.y }); break;
        case 12: segments.push({ ax: E.x, ay: E.y, bx: W.x, by: W.y }); break;
        case 13: segments.push({ ax: E.x, ay: E.y, bx: S.x, by: S.y }); break;
        case 14: segments.push({ ax: S.x, ay: S.y, bx: W.x, by: W.y }); break;
      }
    }
  }
  return segments;
}

interface Pt { x: number; y: number; }

// Walk shared endpoints to splice segments into closed loops. Marching
// squares produces edge-midpoint endpoints that are bit-exact between
// neighbouring cells, so an integer key from rounded coordinates is
// safe — no need for tolerance-based matching.
function buildLoops(segments: Segment[]): Pt[][] {
  if (segments.length === 0) return [];
  const keyOf = (x: number, y: number): number =>
    Math.round(x * 16) * 100000 + Math.round(y * 16);
  // For each endpoint key, list segment indices that touch it. A segment
  // appears once per endpoint (so twice total).
  const adjacency = new Map<number, number[]>();
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const ka = keyOf(s.ax, s.ay);
    const kb = keyOf(s.bx, s.by);
    const la = adjacency.get(ka);
    if (la) la.push(i); else adjacency.set(ka, [i]);
    const lb = adjacency.get(kb);
    if (lb) lb.push(i); else adjacency.set(kb, [i]);
  }
  const used = new Uint8Array(segments.length);
  const loops: Pt[][] = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const first = segments[start];
    const loop: Pt[] = [{ x: first.ax, y: first.ay }];
    let curX = first.bx;
    let curY = first.by;
    loop.push({ x: curX, y: curY });

    while (true) {
      const k = keyOf(curX, curY);
      const candidates = adjacency.get(k);
      if (!candidates) break;
      let pick = -1;
      for (const ci of candidates) {
        if (!used[ci]) { pick = ci; break; }
      }
      if (pick < 0) break;
      used[pick] = 1;
      const seg = segments[pick];
      const akey = keyOf(seg.ax, seg.ay);
      if (akey === k) {
        curX = seg.bx; curY = seg.by;
      } else {
        curX = seg.ax; curY = seg.ay;
      }
      loop.push({ x: curX, y: curY });
      // Closed loop — first and current endpoint match.
      if (Math.abs(curX - loop[0].x) < 0.001 && Math.abs(curY - loop[0].y) < 0.001) break;
    }

    if (loop.length > 3) loops.push(loop);
  }

  return loops;
}

// Chaikin corner-cutting smoothing for a closed polyline. Each iteration
// quadruples the segment count; 3 iterations turns marching-squares
// stairsteps into visibly smooth curves at our grid resolution.
function chaikinClosed(points: Pt[], iterations: number): Pt[] {
  let curr = points;
  for (let it = 0; it < iterations; it++) {
    const n = curr.length;
    const next: Pt[] = new Array(n * 2);
    for (let i = 0; i < n; i++) {
      const a = curr[i];
      const b = curr[(i + 1) % n];
      next[i * 2]     = { x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y };
      next[i * 2 + 1] = { x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y };
    }
    curr = next;
  }
  return curr;
}

function loopToPath(loop: Pt[]): string {
  if (loop.length === 0) return "";
  let out = `M${loop[0].x.toFixed(2)},${loop[0].y.toFixed(2)}`;
  for (let i = 1; i < loop.length; i++) {
    out += `L${loop[i].x.toFixed(2)},${loop[i].y.toFixed(2)}`;
  }
  out += "Z";
  return out;
}

export interface BoundaryOptions {
  // Lattice resolution. With subpixel-accurate marching squares the
  // grid mostly governs how faithfully the boundary tracks the field's
  // curvature, not the line's smoothness — 160×100 reads cleanly at
  // every atlas zoom level we ship.
  gridW?: number;
  gridH?: number;
  // Chaikin iterations applied to every loop. With midpoint marching
  // squares this needed 3+ to look smooth; with subpixel crossings the
  // segment endpoints already sit at the true zero-margin, so 2
  // iterations is plenty to polish the corners between cells without
  // bloating the path string.
  smoothing?: number;
}

// Build the per-syndicate territory boundary set for the given control
// sources. Each entry's pathD covers every closed loop owned by that
// syndicate (multiple disconnected pockets show up as multiple loops in
// the same string). Returns an empty array when there's nothing to
// draw — caller should bail early instead of rendering an empty layer.
export function buildControlBoundaries(
  sources: ControlSource[],
  syndicateIds: SyndicateId[],
  width: number,
  height: number,
  options: BoundaryOptions = {},
): ControlBoundary[] {
  if (sources.length === 0 || syndicateIds.length === 0) return [];
  const gridW = options.gridW ?? 160;
  const gridH = options.gridH ?? 100;
  const smoothing = options.smoothing ?? 2;

  const field = sampleDominantField(sources, syndicateIds, width, height, gridW, gridH);
  const out: ControlBoundary[] = [];
  for (let idx = 0; idx < syndicateIds.length; idx++) {
    const segs = extractSegments(field, idx);
    if (segs.length === 0) continue;
    const loops = buildLoops(segs);
    if (loops.length === 0) continue;
    const smoothed = smoothing > 0
      ? loops.map(l => chaikinClosed(l, smoothing))
      : loops;
    const pathD = smoothed.map(loopToPath).join(" ");
    if (pathD.length > 0) {
      out.push({ syndicateId: syndicateIds[idx], pathD });
    }
  }
  return out;
}
