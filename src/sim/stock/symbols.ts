import type { EquityKind } from "../types";

export function symbolize(name: string, existingSymbols: Iterable<string> = []): string {
  const taken = new Set(
    [...existingSymbols].map(s => s.toUpperCase()),
  );

  const words = name
    .trim()
    .split(/\s+/)
    .map(w => w.replace(/[^a-z0-9]/gi, ""))
    .filter(Boolean);

  if (words.length === 0) {
    return nextNumberedSymbol("X", taken);
  }

  const upperWords = words.map(w => w.toUpperCase());

  // First letter of each word, e.g. "Part Alpha" => "PA"
  const base = upperWords.map(w => w[0]).join("");

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
  let result = tryCandidate(base);
  if (result) return result;

  // Word priority:
  // For "Path Alpha", try Alpha letters first, then Path letters.
  //
  // [1, 2, 3, ..., 0]
  const wordOrder = [
    ...upperWords.slice(1).map((_, i) => i + 1),
    0,
  ];

  // 2. Try short conflicts.
  //
  // For two words:
  // Path Alpha:
  // PA, PL, PP, PH, PA, PA, PT, PH...
  //
  // Duplicates are skipped automatically.
  const anchor = upperWords[0][0];

  for (const wordIndex of wordOrder) {
    const word = upperWords[wordIndex];

    for (let charIndex = 1; charIndex < word.length; charIndex++) {
      const candidate = anchor + word[charIndex];

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
  return nextNumberedSymbol(base, taken);
}

function nextNumberedSymbol(base: string, taken: Set<string>): string {
  let i = 2;

  while (taken.has(`${base}${i}`)) {
    i++;
  }

  return `${base}${i}`;
}

export function symbolizeEquity(kind: EquityKind, name: string, existingSymbols: Iterable<string> = []): string {
  if (kind === "station") {
    return symbolize(name, existingSymbols);
  }

  const prefix = kind[0].toUpperCase();
  const symbolName = equitySymbolSourceName(kind, name);
  const usedBehindPrefix = [...existingSymbols]
    .map(s => s.toUpperCase())
    .filter(s => s.startsWith(prefix))
    .map(s => s.slice(prefix.length))
    .filter(Boolean);

  return `${prefix}${symbolize(symbolName, usedBehindPrefix)}`;
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
