import { describe, expect, test } from "bun:test";
import { preferredSide, resolveLocating } from "../src/content/repo";
import { Locating } from "@grandtour/shared";

// preferredSide(azimuthDeg, courseDeg): azimuth is the bearing from the
// traveler to the spot; course is the direction of travel. Both 0 = north.
describe("preferredSide", () => {
  test("spot due east while heading north is on the right", () => {
    expect(preferredSide(90, 0)).toBe("right");
  });

  test("spot due east while heading south is on the left", () => {
    expect(preferredSide(90, 180)).toBe("left");
  });

  test("spot due west while heading north is on the left", () => {
    expect(preferredSide(270, 0)).toBe("left");
  });

  test("wraps across north: spot at 10° while heading 350° is on the right", () => {
    expect(preferredSide(10, 350)).toBe("right");
  });

  test("unknown course or azimuth yields no preference", () => {
    expect(preferredSide(null, 90)).toBeNull();
    expect(preferredSide(90, undefined)).toBeNull();
  });

  // Left/right must hold for EVERY course, not just the cardinal examples
  // above — a sign or wrap error tends to pass at 0° and fail elsewhere.
  test("full-circle sweep: abeam right/left for every course", () => {
    for (let course = 0; course < 360; course += 15) {
      expect(preferredSide((course + 90) % 360, course)).toBe("right");
      expect(preferredSide((course + 270) % 360, course)).toBe("left");
    }
  });

  test("full-circle sweep: barely clockwise is right, barely counter is left", () => {
    for (let course = 0; course < 360; course += 15) {
      expect(preferredSide((course + 1) % 360, course)).toBe("right");
      expect(preferredSide((course + 359) % 360, course)).toBe("left");
      expect(preferredSide((course + 179) % 360, course)).toBe("right");
      expect(preferredSide((course + 181) % 360, course)).toBe("left");
    }
  });
});

describe("resolveLocating", () => {
  const clips = {
    left: { text: "Look to your left.", audioUrl: "https://cdn/l.mp3", durationMs: 900 },
    right: { text: "Look to your right.", audioUrl: "https://cdn/r.mp3", durationMs: 900 },
  };
  const auto = Locating.parse({ mode: "auto", clips });

  test("substitutes the traveler's actual side and picks the matching clip", () => {
    // Heading north, spot due east: right.
    const east = resolveLocating(auto, 90, 0);
    expect(east).toEqual({ text: "Look to your right.", audioUrl: "https://cdn/r.mp3", durationMs: 900 });
    // Same spot heading south: left.
    const flipped = resolveLocating(auto, 90, 180);
    expect(flipped).toEqual({ text: "Look to your left.", audioUrl: "https://cdn/l.mp3", durationMs: 900 });
  });

  test("directional template with no course resolves to null, never a guessed side", () => {
    expect(resolveLocating(auto, 90, undefined)).toBeNull();
    expect(resolveLocating(auto, null, 0)).toBeNull();
  });

  test("missing clip still resolves the text for the correct side", () => {
    const textOnly = Locating.parse({ mode: "auto", clips: {} });
    expect(resolveLocating(textOnly, 270, 0)).toEqual({
      text: "Look to your left.",
      audioUrl: null,
      durationMs: null,
    });
  });
});
