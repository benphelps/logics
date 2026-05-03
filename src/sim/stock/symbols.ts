import type { EquityKind } from "../types";

export function symbolize(name: string, existingSymbols: Iterable<string> = [], symbolLength = 2): string {
  return symbolizeWithLength(name, existingSymbols, symbolLength, 2);
}

function symbolizeWithLength(
  name: string,
  existingSymbols: Iterable<string> = [],
  symbolLength = 2,
  minimumLength = 2,
): string {
  const targetLength = normalizeSymbolLength(symbolLength, minimumLength);
  const taken = new Set(
    [...existingSymbols].map(s => s.toUpperCase()),
  );

  const words = name
    .trim()
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/gi, ""))
    .filter(Boolean);

  if (words.length === 0) {
    return nextNumberedSymbol("X".repeat(Math.max(1, targetLength - 1)), taken);
  }

  const upperWords = words.map(w => w.toUpperCase());

  // First letter of each word, e.g. "Part Alpha" => "PA"
  const baseWords = upperWords.slice(0, Math.min(upperWords.length, targetLength));
  const base = baseWords.map(w => w[0]).join("");

  const seenCandidates = new Set<string>();

  function tryCandidate(symbol: string): string | null {
    if (seenCandidates.has(symbol)) return null;

    seenCandidates.add(symbol);

    if (!taken.has(symbol)) {
      return symbol;
    }

    return null;
  }

  // 1. Try the plain initials first.
  let result = base.length >= targetLength ? tryCandidate(base) : null;
  if (result) return result;

  // Word priority:
  // For "Path Alpha", try Alpha letters first, then Path letters.
  //
  // [1, 2, 3, ..., 0]
  const wordOrder = [
    ...upperWords.slice(1).map((_, i) => i + 1),
    0,
  ];

  // 2. Try target-length conflicts.
  //
  // For two words:
  // Path Alpha:
  // PA, PL, PP, PH, PA, PA, PT, PH...
  //
  // Duplicates are skipped automatically.
  const stem = base.length >= targetLength
    ? base.slice(0, targetLength - 1)
    : base;
  const needed = targetLength - stem.length;

  for (const wordIndex of wordOrder) {
    const word = upperWords[wordIndex];

    for (let charIndex = 1; charIndex < word.length; charIndex++) {
      const fill = word.slice(charIndex, charIndex + needed);
      if (fill.length < needed) continue;
      const candidate = stem + fill;

      result = tryCandidate(candidate);
      if (result) return result;
    }
  }

  // 3. If all 2-character options are exhausted,
  // start appending letters to the original initials.
  //
  // Path Alpha:
  // PA + L => PAL
  // PA + P => PAP
  // PA + H => PAH
  // ...
  for (const wordIndex of wordOrder) {
    const word = upperWords[wordIndex];

    for (let charIndex = 1; charIndex < word.length; charIndex++) {
      const candidate = base + word[charIndex];

      result = tryCandidate(candidate);
      if (result) return result;
    }
  }

  // 4. Last resort: add numbers.
  return nextNumberedSymbol(baseForNumberedFallback(base, targetLength), taken);
}

function nextNumberedSymbol(base: string, taken: Set<string>): string {
  let i = 2;

  while (taken.has(`${base}${i}`)) {
    i++;
  }

  return `${base}${i}`;
}

function normalizeSymbolLength(symbolLength: number, minimumLength: number): number {
  if (!Number.isFinite(symbolLength)) return minimumLength;
  return Math.max(minimumLength, Math.floor(symbolLength));
}

function baseForNumberedFallback(base: string, targetLength: number): string {
  if (base.length >= targetLength - 1) return base;
  const fill = base[0] ?? "X";
  return base.padEnd(Math.max(1, targetLength - 1), fill);
}

export function symbolizeEquity(
  kind: EquityKind,
  name: string,
  existingSymbols: Iterable<string> = [],
  symbolLength = 3,
): string {
  if (kind === "station") {
    return symbolize(name, existingSymbols, symbolLength);
  }

  const prefix = kind[0].toUpperCase();
  const prefixToken = `${prefix}.`;
  const targetLength = normalizeSymbolLength(symbolLength, 2);
  const bodyLength = Math.max(1, targetLength - prefix.length);
  const symbolName = equitySymbolSourceName(kind, name);
  const usedBehindPrefix = [...existingSymbols]
    .map(s => s.toUpperCase())
    .filter(s => s.startsWith(prefixToken))
    .map(s => s.slice(prefixToken.length))
    .filter(Boolean);

  return `${prefixToken}${symbolizeWithLength(symbolName, usedBehindPrefix, bodyLength, 1)}`;
}

function equitySymbolSourceName(kind: EquityKind, name: string): string {
  if (kind !== "syndicate") return name;

  const words = name.trim().split(/\s+/);
  const last = words.at(-1);
  if (!last || last.replace(/[^a-z0-9]/gi, "").toUpperCase() !== "SYNDICATE") {
    return name;
  }

  return words.slice(0, -1).join(" ");
}
