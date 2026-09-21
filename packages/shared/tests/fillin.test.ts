import { describe, expect, test } from "bun:test";
import {
  FillInGenerateRequest,
  FillInItem,
  FillInItemInput,
  FillInItemsQuery,
  QuizPayload,
  Track,
  VocabImportRequest,
  VocabPayload,
  fillInItemTitle,
  isQuizPayload,
  isVocabPayload,
  payloadSchemaFor,
} from "../src/index";

describe("Track.kind", () => {
  test("defaults to tour so pre-kind rows/clients keep working", () => {
    const t = Track.parse({
      id: "00000000-0000-0000-0000-000000000001",
      slug: "history",
      name: "History",
      createdAt: new Date(0).toISOString(),
    });
    expect(t.kind).toBe("tour");
  });

  test("accepts fillin and rejects unknown kinds", () => {
    const base = {
      id: "00000000-0000-0000-0000-000000000001",
      slug: "vocab",
      name: "Vocab",
      createdAt: new Date(0).toISOString(),
    };
    expect(Track.parse({ ...base, kind: "fillin" }).kind).toBe("fillin");
    expect(() => Track.parse({ ...base, kind: "palace" })).toThrow();
  });
});

describe("QuizPayload and the payload union", () => {
  const quiz = {
    category: "Geography",
    question: "What is the capital of Mongolia?",
    answers: ["Ulaanbaatar"],
    source: { title: "Wikidata", url: "https://query.wikidata.org/" },
  };
  const vocab = {
    word: "loquacious",
    senses: [{ definition: "talkative" }],
    source: { title: "List", url: "https://example.com/list" },
  };

  test("parses and rejects empty answers", () => {
    expect(QuizPayload.parse(quiz).answers).toEqual(["Ulaanbaatar"]);
    expect(() => QuizPayload.parse({ ...quiz, answers: [] })).toThrow();
  });

  test("payloadSchemaFor pairs each module with its own shape", () => {
    expect(payloadSchemaFor("quiz").safeParse(quiz).success).toBe(true);
    expect(payloadSchemaFor("quiz").safeParse(vocab).success).toBe(false);
    expect(payloadSchemaFor("vocab").safeParse(quiz).success).toBe(false);
  });

  test("guards and title discriminate by shape", () => {
    const q = QuizPayload.parse(quiz);
    const v = VocabPayload.parse(vocab);
    expect(isQuizPayload(q)).toBe(true);
    expect(isVocabPayload(q)).toBe(false);
    expect(fillInItemTitle(q)).toBe("What is the capital of Mongolia?");
    expect(fillInItemTitle(v)).toBe("loquacious");
  });

  test("FillInItemInput accepts a quiz item", () => {
    const input = FillInItemInput.parse({
      trackId: "00000000-0000-0000-0000-000000000001",
      moduleType: "quiz",
      payload: quiz,
    });
    expect(input.moduleType).toBe("quiz");
  });
});

describe("VocabPayload", () => {
  const good = {
    word: "loquacious",
    senses: [{ definition: "talkative", exampleSentence: "She was loquacious." }],
    source: { title: "List", url: "https://example.com/list" },
  };

  test("requires word, at least one sense, and a sourced URL", () => {
    expect(VocabPayload.parse(good).word).toBe("loquacious");
    expect(() => VocabPayload.parse({ ...good, word: "" })).toThrow();
    expect(() => VocabPayload.parse({ ...good, senses: [] })).toThrow();
    expect(() =>
      VocabPayload.parse({ ...good, source: { title: "List", url: "not a url" } }),
    ).toThrow();
  });
});

describe("FillInItem", () => {
  test("round-trips, content nullable, status defaults to draft", () => {
    const item = FillInItem.parse({
      id: "00000000-0000-0000-0000-000000000002",
      trackId: "00000000-0000-0000-0000-000000000001",
      moduleType: "vocab",
      payload: {
        word: "loquacious",
        senses: [{ definition: "talkative", exampleSentence: "She was loquacious." }],
        source: { title: "List", url: "https://example.com/list" },
      },
      order: null,
      content: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    });
    expect(item.status).toBe("draft");
    expect(item.content).toBeNull();
  });

  test("input shape: order and status optional, geometry impossible", () => {
    const input = FillInItemInput.parse({
      trackId: "00000000-0000-0000-0000-000000000001",
      moduleType: "vocab",
      payload: {
        word: "alpha",
        senses: [{ definition: "first", exampleSentence: "Alpha comes first." }],
        source: { title: "List", url: "https://example.com/list" },
      },
    });
    expect(input.order).toBeUndefined();
    expect("trigger" in input).toBe(false);
  });
});

describe("API DTOs", () => {
  test("FillInItemsQuery splits tracks and rejects an empty list", () => {
    const q = FillInItemsQuery.parse({ tracks: "vocab,trivia" });
    expect(q.tracks).toEqual(["vocab", "trivia"]);
    expect(q.limit).toBe(2000);
    expect(() => FillInItemsQuery.parse({ tracks: "" })).toThrow();
    expect(() => FillInItemsQuery.parse({})).toThrow();
  });

  test("VocabImportRequest words omit per-word source (stamped by the server)", () => {
    const req = VocabImportRequest.parse({
      trackId: "00000000-0000-0000-0000-000000000001",
      source: { title: "SAT", url: "https://example.com/sat" },
      words: [{ word: "alpha", definition: "first", exampleSentence: "Alpha comes first." }],
    });
    expect(req.words[0]!.word).toBe("alpha");
    expect(() =>
      VocabImportRequest.parse({
        trackId: "00000000-0000-0000-0000-000000000001",
        source: { title: "SAT", url: "https://example.com/sat" },
        words: [],
      }),
    ).toThrow();
  });

  test("FillInGenerateRequest clamps the pause to the provider's 3s max", () => {
    expect(FillInGenerateRequest.parse({}).pauseSeconds).toBe(3);
    expect(() => FillInGenerateRequest.parse({ pauseSeconds: 10 })).toThrow();
  });
});
