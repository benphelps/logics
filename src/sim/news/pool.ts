// Module-level pool. The CLI generator writes to public/news-events.json,
// which the UI fetches once at boot via loadNewsPool(). The sim is synchronous
// — when the pool isn't yet loaded, maybeSpawnEvent returns null gracefully.

import type { NewsEventTemplate } from "./types";

let pool: NewsEventTemplate[] = [];

export function getNewsPool(): NewsEventTemplate[] {
  return pool;
}

export function setNewsPoolForTests(p: NewsEventTemplate[]): void {
  pool = p;
}

interface PoolFile {
  events?: NewsEventTemplate[];
}

export async function loadNewsPool(): Promise<NewsEventTemplate[]> {
  if (typeof fetch === "undefined") return pool;
  try {
    const res = await fetch("/news-events.json");
    if (!res.ok) return pool;
    const data: unknown = await res.json();
    if (Array.isArray(data)) {
      pool = data as NewsEventTemplate[];
    } else if (data && typeof data === "object" && Array.isArray((data as PoolFile).events)) {
      pool = (data as PoolFile).events as NewsEventTemplate[];
    }
    return pool;
  } catch {
    return pool;
  }
}
