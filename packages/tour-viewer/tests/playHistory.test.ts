import { describe, expect, test } from "bun:test";
import { REPLAY_COOLDOWN_MS, RETENTION_MS, persistentHistory, sessionHistory } from "../src/playHistory";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() { return m.size; },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => { m.delete(k); },
    setItem: (k, v) => { m.set(k, v); },
  };
}

describe("persistent play history", () => {
  test("an evergreen story comes back after the phone's 6-hour cooldown", () => {
    let t = 1_000_000;
    const h = persistentHistory({ storage: memoryStorage(), now: () => t });
    h.add("a", { lifecycle: "evergreen" });
    expect(h.has("a")).toBe(true);
    t += REPLAY_COOLDOWN_MS - 1;
    expect(h.has("a")).toBe(true);
    t += 2;
    expect(h.has("a")).toBe(false);
  });

  test("a series story never auto-replays", () => {
    let t = 0;
    const h = persistentHistory({ storage: memoryStorage(), now: () => t });
    h.add("s", { lifecycle: "series" });
    t += 30 * 24 * 3600 * 1000;
    expect(h.has("s")).toBe(true);
  });

  test("survives a reload, ignores player resets, and honours start over", () => {
    const storage = memoryStorage();
    const first = persistentHistory({ storage, now: () => 5 });
    first.add("a");
    first.clear();
    expect(first.has("a")).toBe(true);

    const reloaded = persistentHistory({ storage, now: () => 6 });
    expect(reloaded.has("a")).toBe(true);
    expect(reloaded.lastPlayedAt("a")).toBe(5);
    expect(reloaded.size).toBe(1);

    reloaded.resetAll();
    expect(reloaded.has("a")).toBe(false);
    expect(persistentHistory({ storage }).size).toBe(0);
  });

  test("forgets one track's stories and leaves the rest", () => {
    const storage = memoryStorage();
    const h = persistentHistory({ storage, now: () => 1 });
    h.add("a"); h.add("b"); h.add("c");
    h.forget(["a", "b", "not-there"]);
    expect(h.ids()).toEqual(["c"]);
    expect(persistentHistory({ storage, now: () => 1 }).ids()).toEqual(["c"]);
  });

  test("counts every start, keeps the count across reloads, and reads an older record as heard once", () => {
    const storage = memoryStorage();
    let t = 1_000;
    const h = persistentHistory({ storage, now: () => t });
    h.add("a"); t += 1; h.add("a"); t += 1; h.add("b");
    expect(h.playCount("a")).toBe(2);
    expect(h.playCount("b")).toBe(1);
    expect(h.playCount("never")).toBe(0);
    expect(h.lastPlayedAt("a")).toBe(1_001);
    const reloaded = persistentHistory({ storage, now: () => t });
    expect(reloaded.playCount("a")).toBe(2);
    storage.setItem("gt.app.playHistory", JSON.stringify({ old: { at: t, series: false } }));
    expect(persistentHistory({ storage, now: () => t }).playCount("old")).toBe(1);
  });

  test("drops stories not heard in half a year on load, as the phone does", () => {
    const storage = memoryStorage();
    const now = 10 * RETENTION_MS;
    storage.setItem("gt.app.playHistory", JSON.stringify({
      stale: { at: now - RETENTION_MS - 1, series: false, count: 3 },
      fresh: { at: now - RETENTION_MS + 1, series: false, count: 1 },
    }));
    const h = persistentHistory({ storage, now: () => now });
    expect(h.ids()).toEqual(["fresh"]);
    expect(h.heard("stale")).toBe(false);
  });

  test("session history remembers when and how often", () => {
    let t = 5;
    const h = sessionHistory(() => t);
    h.add("a"); t = 9; h.add("a");
    expect(h.lastPlayedAt("a")).toBe(9);
    expect(h.playCount("a")).toBe(2);
    expect(h.playCount("b")).toBe(0);
  });

  test("tolerates corrupt or missing storage", () => {
    const storage = memoryStorage();
    storage.setItem("gt.app.playHistory", "{not json");
    expect(persistentHistory({ storage }).size).toBe(0);
    const none = persistentHistory({ storage: null });
    none.add("x");
    expect(none.has("x")).toBe(true);
  });

  test("session history forgets on clear", () => {
    const h = sessionHistory();
    h.add("a");
    expect(h.has("a")).toBe(true);
    h.clear();
    expect(h.has("a")).toBe(false);
  });
});
