// Pure tests — no DB. The quiz script builder is deterministic: same
// payload, same script, so drift here is a real behavior change.
import { describe, expect, test } from "bun:test";
import { buildQuizScript, quizThinkPause } from "../src/ai/fillin/quiz";
import type { QuizPayload } from "@grandtour/shared";

const source = { name: "Wikidata", url: "https://query.wikidata.org/" };

const single: QuizPayload = {
  category: "Geography",
  question: "What is the capital of Mongolia?",
  answers: ["Ulaanbaatar"],
  source,
};

const ranked: QuizPayload = {
  category: "Geography",
  question: "Name the three most populous countries whose names begin with the letter M",
  answers: [
    "Mexico, about 130 million people",
    "Myanmar, about 54 million people",
    "Morocco, about 37 million people",
  ],
  note: "In order of population.",
  source,
};

describe("buildQuizScript", () => {
  test("single answer: category intro, question mark added, one answer beat", () => {
    const s = buildQuizScript(single, 3);
    expect(s.displayText).toContain("Geography quiz.");
    expect(s.displayText).toContain("What is the capital of Mongolia? …");
    expect(s.displayText).toContain("The answer: Ulaanbaatar.");
    expect(s.displayText).not.toContain("There are");
    // No TTS markup may leak into the document/display text.
    expect(s.displayText).not.toContain("<break");
  });

  test("multiple answers: count beat, numbered answers in order, note last", () => {
    const s = buildQuizScript(ranked, 3);
    expect(s.displayText).toContain(
      "Name the three most populous countries whose names begin with the letter M? …",
    );
    expect(s.displayText).toContain("There are 3.");
    expect(s.displayText).toContain("One: Mexico, about 130 million people.");
    expect(s.displayText).toContain("Two: Myanmar, about 54 million people.");
    expect(s.displayText).toContain("Three: Morocco, about 37 million people.");
    expect(s.displayText).toContain("In order of population.");
    expect(s.displayText.indexOf("One: Mexico")).toBeLessThan(s.displayText.indexOf("Two: Myanmar"));
  });

  test("think pause scales with answer count and is capped", () => {
    expect(quizThinkPause(3, 1)).toBe(3);
    expect(quizThinkPause(3, 3)).toBe(6);
    expect(quizThinkPause(3, 10)).toBe(10); // capped
    const s = buildQuizScript(ranked, 3);
    expect(s.beats[1]!.pauseAfter).toBe(6);
  });

  test("tts text carries break tags but caps each at the provider max of 3s", () => {
    const s = buildQuizScript(ranked, 3);
    expect(s.ttsText).toContain('<break time="3s" />'); // 6s recall → capped
    expect(s.ttsText).not.toContain('time="6s"');
  });

  test("last beat has no trailing pause and the script ends with the note", () => {
    const s = buildQuizScript(ranked, 3);
    const last = s.beats[s.beats.length - 1]!;
    expect(last.text).toBe("In order of population.");
    expect(last.pauseAfter).toBe(0);
    const noNote = buildQuizScript(single, 3);
    expect(noNote.beats[noNote.beats.length - 1]!.pauseAfter).toBe(0);
  });

  test("existing terminal punctuation is preserved", () => {
    const s = buildQuizScript(
      { ...single, question: "Which is larger: Chile or Zambia?" },
      3,
    );
    expect(s.displayText).toContain("Which is larger: Chile or Zambia? …");
    expect(s.displayText).not.toContain("??");
  });
});
