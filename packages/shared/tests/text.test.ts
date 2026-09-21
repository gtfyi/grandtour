import { describe, expect, test } from "bun:test";
import { byteToStringIndex, slugify } from "../src/text";

describe("slugify", () => {
  test("lowercases, hyphenates, strips diacritics and punctuation", () => {
    expect(slugify("Café de l'Église!")).toBe("cafe-de-l-eglise");
    expect(slugify("Brooklyn Bridge")).toBe("brooklyn-bridge");
    expect(slugify("Gramma and Grampa's house")).toBe("gramma-and-grampa-s-house");
  });

  test("never returns an empty slug", () => {
    expect(slugify("!!!")).toBe("spot");
    expect(slugify("")).toBe("spot");
  });
});

describe("byteToStringIndex", () => {
  test("ASCII: byte offsets equal string indices", () => {
    expect(byteToStringIndex("hello", 0)).toBe(0);
    expect(byteToStringIndex("hello", 3)).toBe(3);
    expect(byteToStringIndex("hello", 5)).toBe(5);
  });

  test("offsets past the end clamp to text.length", () => {
    expect(byteToStringIndex("hi", 99)).toBe(2);
  });

  test("negative offsets clamp to 0", () => {
    expect(byteToStringIndex("hi", -1)).toBe(0);
  });

  test("2-byte character: é is 2 UTF-8 bytes but 1 UTF-16 unit", () => {
    // "héllo" bytes: h=1, é=2, l=1, l=1, o=1
    expect(byteToStringIndex("héllo", 1)).toBe(1); // start of é
    expect(byteToStringIndex("héllo", 3)).toBe(2); // first l
  });

  test("emoji (surrogate pair): 4 UTF-8 bytes, 2 UTF-16 units", () => {
    // "a🌉b" bytes: a=1, 🌉=4, b=1 → b starts at byte 5, string index 3
    expect(byteToStringIndex("a🌉b", 1)).toBe(1); // start of 🌉
    expect(byteToStringIndex("a🌉b", 5)).toBe(3); // start of b
    expect(byteToStringIndex("a🌉b", 6)).toBe(4); // end of text
  });

  test("mid-character offsets clamp forward to the next boundary", () => {
    expect(byteToStringIndex("a🌉b", 2)).toBe(3); // inside 🌉 → start of b
    expect(byteToStringIndex("héllo", 2)).toBe(2); // inside é → first l
  });
});
