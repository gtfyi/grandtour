// Pure tests — no DB. The vocab script builder is deterministic: same
// payload, same script, so drift here is a real behavior change.
import { describe, expect, test } from "bun:test";
import { buildVocabScript, spellOut } from "../src/ai/fillin/vocab";
import type { VocabPayload } from "@grandtour/shared";

const payload: VocabPayload = {
  word: "loquacious",
  senses: [
    {
      partOfSpeech: "adjective",
      definition: "tending to talk a great deal; talkative",
      exampleSentence: "She was so loquacious the meeting ran an hour long.",
    },
  ],
  source: { name: "Test list", url: "https://example.com/vocab" },
};

const multiSense: VocabPayload = {
  word: "temper",
  senses: [
    {
      partOfSpeech: "noun",
      definition: "a tendency to become angry",
      exampleSentence: "He lost his temper in traffic.",
    },
    {
      partOfSpeech: "verb",
      definition: "to moderate or soften",
      exampleSentence: "She tempered her criticism with praise.",
    },
    { partOfSpeech: "verb", definition: "to harden a metal by heating and cooling" },
  ],
  source: { name: "Test list", url: "https://example.com/vocab" },
};

describe("buildVocabScript", () => {
  test("single sense: every beat present, think pause shown as ellipsis", () => {
    const s = buildVocabScript(payload, 3);
    expect(s.displayText).toContain("The word is: loquacious.");
    expect(s.displayText).toContain("Can you define loquacious? …");
    expect(s.displayText).toContain("loquacious, adjective, means:");
    expect(s.displayText).toContain("tending to talk a great deal; talkative.");
    expect(s.displayText).toContain("In a sentence: She was so loquacious");
    expect(s.displayText).toContain("L, O, Q, U, A, C, I, O, U, S");
    // No TTS markup may leak into the document/display text.
    expect(s.displayText).not.toContain("<break");
    expect(s.displayText).not.toContain("{{");
  });

  test("multi sense: counted intro, ordinals, per-sense examples", () => {
    const s = buildVocabScript(multiSense, 3);
    expect(s.displayText).toContain("temper has 3 meanings.");
    expect(s.displayText).toContain("First, as a noun: a tendency to become angry.");
    expect(s.displayText).toContain("In a sentence: He lost his temper in traffic.");
    expect(s.displayText).toContain("Second, as a verb: to moderate or soften.");
    expect(s.displayText).toContain("Third, as a verb: to harden a metal");
    // The example-less third sense adds no "In a sentence" beat after it.
    expect(s.displayText).not.toContain("heating and cooling. In a sentence");
  });

  test("beats carry pauses; tts text renders them as break tags", () => {
    const s = buildVocabScript(payload, 3);
    expect(s.beats[1]!.text).toBe("Can you define loquacious?");
    expect(s.beats[1]!.pauseAfter).toBe(3);
    expect(s.beats.at(-1)!.pauseAfter).toBe(0);
    expect(s.ttsText).toContain('<break time="3s" />');
    expect(s.ttsText).toContain('<break time="0.8s" />');
    expect(s.ttsText).not.toContain("…");
  });

  test("think pause length is configurable", () => {
    expect(buildVocabScript(payload, 1.5).ttsText).toContain('<break time="1.5s" />');
  });

  test("part of speech is optional", () => {
    const s = buildVocabScript(
      { ...payload, senses: [{ definition: payload.senses[0]!.definition }] },
      3,
    );
    expect(s.displayText).toContain("loquacious means:");
    expect(s.displayText).not.toContain("adjective");
  });

  test("definitions and sentences get terminal punctuation exactly once", () => {
    const s = buildVocabScript(
      {
        ...payload,
        senses: [
          { partOfSpeech: "adjective", definition: "talkative", exampleSentence: "He talks a lot!" },
        ],
      },
      3,
    );
    expect(s.displayText).toContain("means: talkative.");
    expect(s.displayText).toContain("He talks a lot!");
    expect(s.displayText).not.toContain("lot!.");
  });
});

describe("spellOut", () => {
  test("letters uppercase, comma-separated", () => {
    expect(spellOut("cat")).toBe("C, A, T");
  });

  test("hyphens and apostrophes are named, spaces dropped", () => {
    expect(spellOut("well-being")).toBe("W, E, L, L, hyphen, B, E, I, N, G");
    expect(spellOut("ne'er do")).toBe("N, E, apostrophe, E, R, D, O");
  });
});
