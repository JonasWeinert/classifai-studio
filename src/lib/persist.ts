// UI state that survives restarts (drafts, last page, theme…), stored in the app's SQLite database
// next to datasets and experiments. `initPersist` loads everything once before the first render, so
// `load` stays synchronous; `save` updates the cache at once and writes through shortly after.
import { api } from "./api";

const PREFIX = "classifai:";

let cache: Record<string, unknown> = {};
const pending = new Map<string, ReturnType<typeof setTimeout>>();

/** Load all UI state. Moves anything older builds kept in browser storage into the database. */
export async function initPersist() {
  try {
    cache = await api.uiState();
  } catch {
    cache = {};
  }
  try {
    const legacy = Object.keys(localStorage).filter((k) => k.startsWith(PREFIX) || k === "datasets.view");
    for (const k of legacy) {
      const key = k.startsWith(PREFIX) ? k.slice(PREFIX.length) : k;
      if (!(key in cache)) {
        try {
          const raw = localStorage.getItem(k) ?? "null";
          const value = k === "datasets.view" ? raw : JSON.parse(raw);
          cache[key] = value;
          await api.uiStateSet(key, value);
        } catch {
          /* unreadable leftover: drop it */
        }
      }
      localStorage.removeItem(k);
    }
  } catch {
    /* storage unavailable */
  }
}

export function load<T>(key: string, fallback: T): T {
  return key in cache && cache[key] !== null ? (cache[key] as T) : fallback;
}

/** Store a value; `null` removes it. Writes are coalesced per key. */
export function save(key: string, value: unknown, delayMs = 300) {
  cache[key] = value;
  clearTimeout(pending.get(key));
  pending.set(
    key,
    setTimeout(() => {
      pending.delete(key);
      api.uiStateSet(key, value).catch(() => {
        /* keep working from memory */
      });
    }, delayMs),
  );
}
