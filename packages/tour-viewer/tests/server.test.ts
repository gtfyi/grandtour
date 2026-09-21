import { describe, expect, test } from "bun:test";
import { resolveServer } from "../src/server";

describe("resolveServer", () => {
  const origin = "https://grandtour.fyi";
  test("a ?server= override wins for the visit", () => {
    expect(resolveServer({ param: "github.com/gtfyi/content", stored: "example.org", origin })).toBe("github.com/gtfyi/content");
  });
  test("a saved choice beats the page's origin", () => {
    expect(resolveServer({ param: null, stored: " example.org ", origin })).toBe("example.org");
  });
  test("the page's own origin is the default", () => {
    expect(resolveServer({ param: "", stored: "", origin })).toBe(origin);
    expect(resolveServer({ param: null, stored: null, origin: "http://localhost:5190" })).toBe("http://localhost:5190");
  });
});
