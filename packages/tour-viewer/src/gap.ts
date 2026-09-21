/**
 * The pause between stories — the phone's `NarrationGapPreference`: 3 s by
 * default, longer choices kept. An older saved 15 s (the previous default)
 * upgrades to 3 s; a deliberately longer choice is preserved.
 */
export const GAP_OPTIONS = [3, 15, 30, 45, 60] as const;
export const GAP_KEY = "narrationGapSecondsV2";
const LEGACY_KEY = "narrationGapSeconds";

export function loadGapSeconds(): number {
  try {
    const saved = Number(localStorage.getItem(GAP_KEY));
    if (GAP_OPTIONS.includes(saved as (typeof GAP_OPTIONS)[number])) return saved;
    const legacy = Number(localStorage.getItem(LEGACY_KEY));
    if (legacy && legacy !== 15 && GAP_OPTIONS.includes(legacy as (typeof GAP_OPTIONS)[number])) return legacy;
  } catch { /* private storage */ }
  return 3;
}
