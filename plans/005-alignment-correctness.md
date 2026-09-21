# Plan 005: Make text⇄audio alignment correct for non-BMP text and surface timing mismatches

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat $(grep -oE '[0-9a-f]{7,}' <(grep "Baseline commit" plans/README.md))..HEAD -- packages/shared/src admin/src/ContentEditor.tsx server/src/ai ios/Sources/TranscriptView.swift`
> If any in-scope file changed since the baseline, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/001-vcs-baseline.md
- **Category**: bug
- **Planned at**: baseline commit from plan 001, 2026-07-05

## Why this matters

The product's signature feature is highlighting the sentence being spoken.
That depends on mapping UTF-8 byte offsets (filo's coordinate system) to
platform string indices, and on per-character TTS timings lining up with the
text. Three related defects:

1. **Admin preview (confirmed by tracing)**: `byteToStringIndex` in
   `ContentEditor.tsx` iterates `text[i]`, which walks **UTF-16 code units**.
   An emoji like 🌉 is a surrogate pair — two lone surrogates that
   `TextEncoder` encodes as two 3-byte U+FFFD replacements (6 bytes) instead
   of the character's real 4 UTF-8 bytes. Every highlight after any non-BMP
   character in a narration is shifted.
2. **Server alignment**: `alignAudioToSentences` clamps indices into
   `charEndMs` with `Math.min(..., charEndMs.length - 1)`. If ElevenLabs
   ever returns fewer character timings than the text has (or counts
   characters differently — it reports code-point-ish characters while
   `doc.stringIndexForByteOffset` yields UTF-16 indices), the clamp silently
   maps trailing sentences to the last timestamp instead of failing loudly.
3. **iOS**: `TranscriptView.stringRange` returns `nil` (no highlight at all)
   when a byte range lands mid-character — reasonable defense, but silent.

The fix: one shared, correct, tested byte↔index function used by the admin;
a validated character-timing mapping on the server; a logged fallback on iOS.

## Current state

- `admin/src/ContentEditor.tsx` lines 26–35 — the buggy function:

```ts
/** Map a byte offset in the doc text to a JS string index (UTF-8 aware). */
function byteToStringIndex(text: string, byteOffset: number): number {
  const enc = new TextEncoder();
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    if (bytes >= byteOffset) return i;
    bytes += enc.encode(text[i]).length;   // <-- text[i] is a UTF-16 unit; breaks on surrogate pairs
  }
  return text.length;
}
```

  It is called at lines 51–52 from the `preview` memo. Note: the loop logic
  itself is NOT off-by-one (a prior review claimed so incorrectly); only the
  code-unit iteration is wrong.

- `server/src/ai/generate.ts` lines 151–156 — the silent clamp:

```ts
  for (const s of sentences) {
    // Convert the sentence's byte range back to string indices for char timing.
    const startStr = doc.stringIndexForByteOffset(s.start);
    const endStr = doc.stringIndexForByteOffset(s.end);
    const startMs = startStr > 0 ? charEndMs[Math.min(startStr - 1, charEndMs.length - 1)]! : 0;
    const endMs = charEndMs[Math.min(endStr - 1, charEndMs.length - 1)]!;
```

- `server/src/ai/tts.ts` — `synthesize()` returns
  `{ audio, mimeType, durationMs, charEndMs, text }`. Lines 52–63: it parses
  ElevenLabs' `alignment.characters` (an array of per-character strings) and
  `character_end_times_seconds`, but **discards `characters`** — only the
  times survive. That array is exactly what's needed to build a trustworthy
  index mapping.
- `ios/Sources/TranscriptView.swift` lines 33–41 — `stringRange` uses
  `utf8.index(offsetBy:)` + `samePosition(in:)`, returning `nil` on
  mid-character offsets; the caller (line 19) then shows no highlight.
- `packages/shared/src/index.ts` — re-exports `./geo`, `./filo`,
  `./content`, `./api` (4 lines). Shared package tests live in
  `packages/shared/tests/schema.test.ts` (bun:test — the structural pattern
  for new shared tests).
- Existing server test exercising alignment:
  `server/tests/align.test.ts` — builds a `FiloDocument`, calls
  `alignAudioToSentences` with synthetic 100ms/char timings, asserts per-
  sentence `startMs`/`endMs`. ASCII-only today.
- The filo library is a local path dependency (`file:../../filo`). Its
  `doc.stringIndexForByteOffset(byte)` returns a JS string index (UTF-16
  code units). Confirm this while working (see STOP conditions).

## Commands you will need

| Purpose      | Command                                | Expected on success |
|--------------|----------------------------------------|---------------------|
| Typecheck    | `bun run typecheck` (repo root)        | exit 0              |
| Shared tests | `cd packages/shared && bun test`       | all pass            |
| Server tests | `cd server && bun test`                | all pass            |

(iOS: there is no test target configured; the Swift change is verified by
typechecking via `xcodegen generate && xcodebuild build` only if Xcode is
available — otherwise flag it for manual build, see Step 4.)

## Scope

**In scope** (the only files you should modify/create):
- `packages/shared/src/text.ts` (create), `packages/shared/src/index.ts` (one export line)
- `packages/shared/tests/text.test.ts` (create)
- `admin/src/ContentEditor.tsx`
- `server/src/ai/tts.ts`, `server/src/ai/generate.ts`
- `server/tests/align.test.ts` (extend)
- `ios/Sources/TranscriptView.swift`

**Out of scope** (do NOT touch):
- The filo library itself (`../filo`, outside this repo).
- `packages/shared/src/filo.ts` — wire schemas; the new helper goes in a new
  `text.ts`, not there.
- Word-level alignment (README roadmap item) — sentence-level only.
- `admin/src/App.tsx`, `MapView.tsx`.

## Git workflow

- Branch: `advisor/005-alignment-correctness` off `main`.
- Commit per step, imperative messages, e.g. `Fix byte→index mapping for surrogate pairs`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Shared, correct `byteToStringIndex`

Create `packages/shared/src/text.ts`:

```ts
const enc = new TextEncoder();

/**
 * Map a UTF-8 byte offset in `text` to the corresponding JS string index
 * (UTF-16 code units). Iterates by code point so surrogate pairs count
 * their true UTF-8 width. Offsets landing mid-character clamp forward to
 * the next character boundary. Offsets past the end return text.length.
 */
export function byteToStringIndex(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  let bytes = 0;
  let i = 0;
  for (const ch of text) {          // iterates by code point
    if (bytes >= byteOffset) return i;
    bytes += enc.encode(ch).length; // true UTF-8 width (1–4 bytes)
    i += ch.length;                 // 1 or 2 UTF-16 units
  }
  return text.length;
}
```

Add `export * from "./text";` to `packages/shared/src/index.ts`.

**Verify**: `bun run typecheck` → exit 0.

### Step 2: Test it, then use it in the admin

Create `packages/shared/tests/text.test.ts` (model on `schema.test.ts`),
covering at minimum:

- ASCII: `byteToStringIndex("hello", 3)` → 3; offset 0 → 0; offset ≥ byte
  length → `text.length`.
- 2-byte char: `"héllo"` — `é` is 2 UTF-8 bytes, 1 UTF-16 unit: offset 3 → 2.
- Emoji (the regression this plan fixes): `"a🌉b"` — 🌉 is 4 UTF-8 bytes and
  2 UTF-16 units, so offset 5 (start of `b`) → 3; offset 1 → 1.
- Mid-character clamp: `"a🌉b"` offset 2 (inside 🌉) → 3 (next boundary).

Then in `admin/src/ContentEditor.tsx`: delete the local
`byteToStringIndex` (lines 26–35) and import it from `@grandtour/shared`.
No other changes to the component.

**Verify**: `cd packages/shared && bun test` → all pass including the new
file; `bun run typecheck` → exit 0;
`grep -n "new TextEncoder" admin/src/ContentEditor.tsx` → no matches.

### Step 3: Server — map ElevenLabs characters to string indices, validate loudly

3a. In `server/src/ai/tts.ts`, stop discarding the character strings.
Extend `TtsResult` with `chars: string[]` (the per-character strings from
`data.alignment.characters`, `[]` when absent) and return it. Everything
else unchanged.

3b. In `server/src/ai/generate.ts`, build the timing lookup from the actual
characters instead of assuming index parity. Add a helper in the same file:

```ts
/**
 * ElevenLabs reports timings per character (its own segmentation). Expand
 * them into an array indexed by JS string index (UTF-16 units) of the text
 * those characters concatenate to, so sentence string-index spans can look
 * up end times directly. Returns null when the characters don't
 * reconstruct `text` — callers must treat that as an alignment failure.
 */
export function charTimesByStringIndex(
  text: string,
  chars: string[],
  charEndMs: number[],
): number[] | null {
  if (chars.length !== charEndMs.length) return null;
  if (chars.join("") !== text) return null;
  const out = new Array<number>(text.length);
  let i = 0;
  for (let k = 0; k < chars.length; k++) {
    for (let u = 0; u < chars[k]!.length; u++) out[i++] = charEndMs[k]!;
  }
  return out;
}
```

In `generateNarration` (currently line 116), replace the direct call with:

```ts
    const times = charTimesByStringIndex(script.text, tts.chars, tts.charEndMs);
    if (!times) {
      throw new Error(
        `TTS alignment mismatch: ElevenLabs returned ${tts.chars.length} characters ` +
          `for a ${script.text.length}-unit script. Refusing to save misaligned audio.`,
      );
    }
    alignAudioToSentences(doc, sentenceTier, times, audioUrl, tts.mimeType);
```

Keep `alignAudioToSentences`'s signature and clamping as-is — with a
validated same-length array the clamps become inert, and the existing test
still passes unchanged. (The thrown error surfaces to the admin via the
generate route's error handling; if plan 002 landed, it becomes the generic
502 with server-side log — acceptable.)

**Verify**: `bun run typecheck` → exit 0; `cd server && bun test` → all pass.

### Step 4: Extend server tests + iOS logged fallback

4a. In `server/tests/align.test.ts`, add:

- A `charTimesByStringIndex` describe-block: identity case (ASCII, each
  `chars[k]` one char) returns per-index times; multi-unit case
  (`chars: ["a", "🌉", "b"]`, times `[100, 200, 300]`, text `"a🌉b"`) →
  `[100, 200, 200, 300]`; mismatch cases (`chars.join() !== text`, length
  mismatch) → null.
- An end-to-end emoji case: build
  `FiloDocument.fromText("Look at the 🌉 span. It glows.")`, annotate
  sentences, feed times produced by `charTimesByStringIndex` from synthetic
  per-code-point chars, and assert the second sentence's `startMs` is
  strictly greater than the first sentence's `endMs` minus one step —
  i.e., timings remain monotonic across the emoji.

4b. In `ios/Sources/TranscriptView.swift`, keep behavior but stop failing
silently: in `stringRange`, when `samePosition(in:)` returns nil, fall back
to the nearest character boundary instead of nil — replace the two
`samePosition` lets with a small helper that tries `samePosition` and, on
nil, walks the byte index forward (up to 3 bytes) until one succeeds. If the
walk fails, return nil as today. Add a `// misaligned byte range; clamped`
comment — no logging framework exists, don't add one.

**Verify**: `cd server && bun test` → all pass, including the new emoji
cases. For iOS: if `xcodegen` and Xcode are installed, run
`cd ios && xcodegen generate && xcodebuild -project GrandTour.xcodeproj -scheme GrandTour -destination 'generic/platform=iOS Simulator' build`
→ succeeds. If Xcode tooling is unavailable in your environment, state that
the Swift change is unverified-by-build in your report; do not skip the
change itself.

## Test plan

Steps 2 and 4a are the test plan: `packages/shared/tests/text.test.ts`
(new, ≥6 cases) and extensions to `server/tests/align.test.ts` (≥4 cases),
both modeled on the existing bun:test files next to them. Verification:
`cd packages/shared && bun test` and `cd server && bun test` → all pass.

## Done criteria

- [ ] `bun run typecheck` exits 0
- [ ] `cd packages/shared && bun test` exits 0 with `text.test.ts` present
- [ ] `cd server && bun test` exits 0 with the emoji/mismatch cases present
- [ ] `grep -c "byteToStringIndex" admin/src/ContentEditor.tsx` → 1+ (import/use only, no local definition)
- [ ] `grep -n "chars" server/src/ai/tts.ts` shows `chars` in `TtsResult`
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The excerpts don't match the live code.
- `bun install` fails because `../filo` (a `file:` dependency outside this
  repo, expected at `~/projects/filo`) is missing on this machine.
- You discover `doc.stringIndexForByteOffset` returns something other than
  UTF-16 string indices (check filo's source/types at `../filo` — read-only)
  — the Step 3 helper's contract would be wrong and needs redesign, not
  improvisation.
- The existing `align.test.ts` assertions fail after Step 3 (they must not —
  that signals a behavioral change beyond the validated mapping).

## Maintenance notes

- Word-level alignment (roadmap) should reuse `charTimesByStringIndex` and
  the shared `byteToStringIndex` — no new coordinate conversions.
- If a second TTS provider is added, its adapter must produce the same
  `{ chars, charEndMs }` contract or provide its own validated mapping.
- Reviewer should scrutinize: the emoji test actually contains a non-BMP
  character (easy to lose in copy-paste), and that ContentEditor imports
  from `@grandtour/shared` rather than re-declaring.
