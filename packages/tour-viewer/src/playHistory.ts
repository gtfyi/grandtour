/**
 * What has already been heard — the web counterpart of the phone's
 * `PlayHistory`, with the same replay rules as `SpotScheduler`:
 *
 * - an **evergreen** story is available again after a cooldown, so tomorrow's
 *   commute can revisit a favourite (`replayCooldownS` on the phone is 6 h);
 * - a **series** story is heard once and never auto-replays.
 *
 * Manual taps always play regardless; this only gates automatic starts.
 */
import type { TrackLifecycle } from "@grandtour/shared";

/** Mirrors `SpotScheduler.replayCooldownS`. */
export const REPLAY_COOLDOWN_MS = 6 * 3600 * 1000;
/** Mirrors `PlayHistory.retentionS`: a story not heard in half a year is new again, and the store stays bounded. */
export const RETENTION_MS = 180 * 24 * 3600 * 1000;

export interface PlayHistory {
  /** True while an automatic start of this story should be suppressed. */
  has(id: string): boolean;
  /** True once this story has ever been heard — what a sequence's later parts wait for. */
  heard(id: string): boolean;
  add(id: string, meta?: { lifecycle?: TrackLifecycle }): void;
  /** Forget everything this *session* remembered. Persistent stores ignore it. */
  clear(): void;
  /** When the story last started (ms on the store's clock), for the scheduler's cooldown and freshness tiers. */
  lastPlayedAt(id: string): number | null;
  /** How many times it has started — the phone's `PlayHistory.playCount`, a scheduler tie-break. */
  playCount(id: string): number;
}

/** In-memory history: what the authoring preview and simulator use. */
export function sessionHistory(now: () => number = Date.now): PlayHistory {
  const heard = new Map<string, { at: number; count: number }>();
  return {
    has: (id) => heard.has(id),
    heard: (id) => heard.has(id),
    add: (id) => { heard.set(id, { at: now(), count: (heard.get(id)?.count ?? 0) + 1 }); },
    clear: () => heard.clear(),
    lastPlayedAt: (id) => heard.get(id)?.at ?? null,
    playCount: (id) => heard.get(id)?.count ?? 0,
  };
}

interface Record_ { at: number; series: boolean; count: number }

export interface PersistentHistory extends PlayHistory {
  /** Every story ever recorded — per-track progress is `ids ∩ track`. */
  ids(): string[];
  /** Forget some stories: one track's "Start over". */
  forget(ids: Iterable<string>): void;
  /** The explicit "start over" for everything — the only other thing that wipes a stored history. */
  resetAll(): void;
  readonly size: number;
}

/**
 * History that survives reloads, so refreshing the page mid-walk does not
 * replay the last hour. `clear()` is deliberately a no-op here: the player
 * calls it on its own resets, and none of those mean "forget my walk".
 */
export function persistentHistory(
  options: { key?: string; storage?: Storage | null; now?: () => number; cooldownMs?: number } = {},
): PersistentHistory {
  const key = options.key ?? "gt.app.playHistory";
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? REPLAY_COOLDOWN_MS;
  const storage = options.storage === undefined ? safeStorage() : options.storage;

  let records: Map<string, Record_> = load();

  function load(): Map<string, Record_> {
    try {
      const raw = storage?.getItem(key);
      if (!raw) return new Map();
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return new Map();
      const out = new Map<string, Record_>();
      const cutoff = now() - RETENTION_MS;
      for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (value && typeof value === "object" && typeof (value as Record_).at === "number" && (value as Record_).at > cutoff) {
          const count = (value as Record_).count;
          out.set(id, { at: (value as Record_).at, series: Boolean((value as Record_).series), count: typeof count === "number" && count > 0 ? count : 1 });
        }
      }
      return out;
    } catch {
      return new Map();
    }
  }
  function save() {
    try {
      storage?.setItem(key, JSON.stringify(Object.fromEntries(records)));
    } catch {
      // Private mode or a full store: the session still works, it just forgets on reload.
    }
  }

  return {
    has(id) {
      const rec = records.get(id);
      if (!rec) return false;
      return rec.series || now() - rec.at < cooldownMs;
    },
    heard: (id) => records.has(id),
    add(id, meta) {
      records.set(id, { at: now(), series: meta?.lifecycle === "series", count: (records.get(id)?.count ?? 0) + 1 });
      save();
    },
    clear() { /* a player reset is not "start over" */ },
    lastPlayedAt: (id) => records.get(id)?.at ?? null,
    playCount: (id) => records.get(id)?.count ?? 0,
    ids: () => [...records.keys()],
    forget(ids) {
      for (const id of ids) records.delete(id);
      save();
    },
    resetAll() {
      records = new Map();
      save();
    },
    get size() { return records.size; },
  };
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
