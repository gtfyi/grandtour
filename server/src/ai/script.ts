import Anthropic from "@anthropic-ai/sdk";
import { env } from "../env";
import type { SourceDoc } from "./search";

export interface ScriptRequest {
  spotTitle: string;
  spotSubtitle?: string;
  trackName: string;
  /** Human-readable location, e.g. "Blue Hill, Maine, United States". */
  placeLabel: string;
  brief?: string;
  targetSeconds: number;
  sources: SourceDoc[];
}

export interface ScriptResult {
  text: string;
  usedSources: SourceDoc[];
}

function anthropic(): Anthropic {
  return new Anthropic({
    apiKey: env.requireAnthropicKey(),
    ...(env.anthropicBaseUrl() ? { baseURL: env.anthropicBaseUrl() } : {}),
  });
}

export interface VetRequest {
  spotTitle: string;
  spotSubtitle?: string;
  /** Creator brief — the specific story this spot should tell. */
  brief?: string;
  placeLabel: string;
  lat: number;
  lng: number;
  sources: SourceDoc[];
}

/**
 * Confirm each gathered source is plausibly about THIS spot at THIS location,
 * and drop the ones that aren't. Guards against exa/Wikipedia returning a
 * same-named-but-wrong-place article (the "Lisbon clinic for a Maine spot" bug).
 *
 * Returns the subset of sources judged relevant. Sources with no text are
 * dropped up front (nothing to verify or use).
 */
export async function vetSources(req: VetRequest): Promise<SourceDoc[]> {
  const candidates = req.sources.filter((s) => s.text.trim());
  if (candidates.length === 0) return [];

  const client = anthropic();
  const list = candidates
    .map(
      (s, i) =>
        `[${i}] ${s.title} (${s.url})\n${s.text.trim().slice(0, 600)}`,
    )
    .join("\n\n");

  const system =
    "You verify whether reference texts are about a specific real-world place. " +
    "You are strict: a source is RELEVANT only if it is about the named place — or " +
    "about the story the creator brief says this place should tell (a person, event, " +
    "or work tied to it) — AND is consistent with the given location " +
    "(city/state/country). A source about a similarly-named place in a different " +
    "city or country is NOT relevant, and neither is one about the brief's subject " +
    "that contradicts this location. " +
    "Respond with ONLY a JSON array of the integer indices that are relevant, e.g. [0,2].";

  const user = [
    `Spot: ${req.spotTitle}${req.spotSubtitle ? ` — ${req.spotSubtitle}` : ""}`,
    ...(req.brief ? [`Creator brief: ${req.brief}`] : []),
    `Location: ${req.placeLabel} (lat ${req.lat}, lng ${req.lng})`,
    "",
    "Sources:",
    list,
    "",
    "Return the JSON array of relevant indices only.",
  ].join("\n");

  try {
    const msg = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 200,
      system,
      messages: [{ role: "user", content: user }],
    });
    const raw = msg.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");
    const match = raw.match(/\[[\d,\s]*\]/);
    if (!match) return [];
    const indices = JSON.parse(match[0]) as number[];
    return indices
      .filter((i) => Number.isInteger(i) && i >= 0 && i < candidates.length)
      .map((i) => candidates[i]!);
  } catch {
    // If verification itself fails, be conservative: keep nothing rather than
    // risk wrong-place narration. The caller turns "no sources" into a refusal.
    return [];
  }
}

/**
 * Draft a spoken narration script for a spot using Claude, grounded in the
 * gathered sources. The output is plain prose meant to be read aloud — no
 * headings, no markdown, no source citations inline.
 */
export async function draftNarration(req: ScriptRequest): Promise<ScriptResult> {
  const client = anthropic();

  // ~150 spoken words per minute.
  const targetWords = Math.round((req.targetSeconds / 60) * 150);

  const sourceBlock = req.sources
    .filter((s) => s.text.trim())
    .map((s, i) => `[Source ${i + 1}: ${s.title}]\n${s.text.trim()}`)
    .join("\n\n");

  const system = [
    "You are a master local tour guide writing audio narration for a location-aware",
    "tour app. You write warm, vivid, spoken-word commentary that a traveler hears",
    "while standing at or moving past a place.",
    "",
    "Rules:",
    "- The narration is about THE SPECIFIC NAMED PLACE AT THE GIVEN LOCATION — never a",
    "  similarly-named place elsewhere. If a source is clearly about a different city,",
    "  state, or country, ignore it entirely.",
    "- Write ONLY the words to be spoken. No titles, headings, markdown, or stage directions.",
    "- Ground every claim in the provided sources. Do not invent facts, dates, or names.",
    "- If sources are thin, keep it short and evocative rather than padding with filler.",
    "- Natural sentences, second person where it fits, conversational rhythm.",
    "- Never tell the listener which way to look or turn (no 'on your left/right',",
    "  'ahead of you', 'behind you') — a separate locating instruction, resolved",
    "  from the traveler's actual heading, handles orientation. Describe the place",
    "  itself as if the listener is already looking at it.",
  ].join("\n");

  const user = [
    `Place: ${req.spotTitle}${req.spotSubtitle ? ` — ${req.spotSubtitle}` : ""}`,
    `Location: ${req.placeLabel}`,
    `Track/theme: ${req.trackName}`,
    req.brief ? `Creator brief: ${req.brief}` : "",
    `Target length: about ${targetWords} words (~${req.targetSeconds}s spoken).`,
    "",
    sourceBlock
      ? `Sources (already filtered to this location):\n\n${sourceBlock}`
      : `No external sources were found. Write only what is broadly, safely known about ${req.spotTitle} at ${req.placeLabel} without inventing specifics.`,
  ]
    .filter(Boolean)
    .join("\n");

  const msg = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 2000,
    system,
    messages: [{ role: "user", content: user }],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  return { text, usedSources: req.sources.filter((s) => s.text.trim()) };
}
