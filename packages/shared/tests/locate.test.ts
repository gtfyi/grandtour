import { describe, expect, test } from "bun:test";
import { cardinal, describeSpotLocation, distancePhrase, sector, sectorAt } from "../src/locate";
import { bearingDeg, haversineM } from "../src/geo";

// Fairfax Scoop, from the live track — a real coordinate to anchor sanity.
const SCOOP = { lat: 37.9869794, lng: -122.5893495 };
/** A point `meters` away from SCOOP at compass `bearing`. */
function from(meters: number, bearing: number) {
  const rad = Math.PI / 180;
  const dLat = (meters * Math.cos(bearing * rad)) / 111_320;
  const dLng =
    (meters * Math.sin(bearing * rad)) / (111_320 * Math.cos(SCOOP.lat * rad));
  return { lat: SCOOP.lat + dLat, lng: SCOOP.lng + dLng };
}

describe("geometry", () => {
  test("haversine and bearing agree with the constructed offset", () => {
    const u = from(500, 90); // 500m east of the spot
    expect(haversineM(u, SCOOP)).toBeCloseTo(500, -1);
    // From the user, the spot is due west.
    expect(bearingDeg(u, SCOOP)).toBeCloseTo(270, 0);
  });

  test("sector boundaries", () => {
    expect(sector(0)).toBe("ahead");
    expect(sector(344.9)).toBe("aheadLeft");
    expect(sector(345)).toBe("ahead");
    expect(sector(15)).toBe("aheadRight");
    expect(sector(90)).toBe("right");
    expect(sector(180)).toBe("behind");
    expect(sector(200)).toBe("behindLeft");
    expect(sector(270)).toBe("left");
  });

  test("cardinal winds", () => {
    expect(cardinal(0)).toBe("north");
    expect(cardinal(22.4)).toBe("north");
    expect(cardinal(22.5)).toBe("northeast");
    expect(cardinal(359)).toBe("north");
    expect(cardinal(225)).toBe("southwest");
  });
});

/**
 * A spot placed in the traveler's course frame: the traveler stands at SCOOP
 * heading `courseDeg`; the spot sits `alongM` down the line of travel
 * (+ ahead, − behind) and `lateralM` across it (+ right, − left). Ground
 * truth by construction — a sign error anywhere in the bearing/side chain
 * flips these and fails.
 */
function locateInCourseFrame(
  courseDeg: number | null,
  alongM: number,
  lateralM: number,
): string {
  const rad = Math.PI / 180;
  const c = (courseDeg ?? 0) * rad;
  const east = alongM * Math.sin(c) + lateralM * Math.sin(c + Math.PI / 2);
  const north = alongM * Math.cos(c) + lateralM * Math.cos(c + Math.PI / 2);
  return describeSpotLocation({
    spotLat: SCOOP.lat + north / 111_320,
    spotLng: SCOOP.lng + east / (111_320 * Math.cos(SCOOP.lat * rad)),
    userLat: SCOOP.lat,
    userLng: SCOOP.lng,
    courseDeg,
    anchor: null,
    metric: true,
  });
}

describe("directionality: left and right, for every course", () => {
  // Including awkward courses: wrap-around (350°) and off-axis diagonals.
  const courses = [0, 45, 90, 135, 180, 225, 270, 315, 350];

  test("a spot abeam to the right says right; to the left says left", () => {
    for (const c of courses) {
      expect(locateInCourseFrame(c, 0, 30)).toBe("To your right, about 30 meters away.");
      expect(locateInCourseFrame(c, 0, -30)).toBe("To your left, about 30 meters away.");
    }
  });

  test("ahead-right and ahead-left resolve their sides", () => {
    for (const c of courses) {
      expect(locateInCourseFrame(c, 100, 40)).toBe("Coming up in 100 meters on your right.");
      expect(locateInCourseFrame(c, 100, -40)).toBe("Coming up in 100 meters on your left.");
    }
  });

  test("behind-right and behind-left resolve their sides", () => {
    for (const c of courses) {
      expect(locateInCourseFrame(c, -100, 40)).toBe("Back 100 meters on your right.");
      expect(locateInCourseFrame(c, -100, -40)).toBe("Back 100 meters on your left.");
    }
  });
});

describe("street walk: the ahead corridor", () => {
  // The reported field bug: walking down a street, a storefront 200m up but
  // across the road used to read "straight ahead" (it sat inside the ±15°
  // cone). Almost everything on a street is on a side — only spots within
  // CORRIDOR_M of the traveler's own line may say "ahead"/"behind".
  test("a spot up the street but off your line is on a side, not straight ahead", () => {
    expect(locateInCourseFrame(0, 200, 15)).toBe("Coming up in 200 meters on your right.");
    expect(locateInCourseFrame(0, 200, -15)).toBe("Coming up in 200 meters on your left.");
  });

  test("only spots on the traveler's own line read straight ahead", () => {
    expect(locateInCourseFrame(0, 200, 0)).toBe("Coming up in 200 meters, straight ahead.");
    expect(locateInCourseFrame(0, 200, 8)).toBe("Coming up in 200 meters, straight ahead.");
  });

  test("far away, even slightly off-line resolves a side", () => {
    expect(locateInCourseFrame(90, 1000, 25)).toBe("Coming up in 1.0 kilometers on your right.");
  });

  test("behind uses the same corridor", () => {
    expect(locateInCourseFrame(0, -150, 20)).toBe("Back 150 meters on your right.");
    expect(locateInCourseFrame(0, -150, 0)).toBe("150 meters behind you.");
  });

  test("close range: the corridor is wider than the cone, so nothing changes", () => {
    // 30m ahead, 5m right: within both the ±15° cone and the corridor.
    expect(locateInCourseFrame(0, 30, 5)).toBe("Coming up in 30 meters, straight ahead.");
  });

  test("sectorAt demotes wide ahead/behind to the correct side", () => {
    expect(sectorAt(5, 300)).toBe("aheadRight"); // lateral ≈ 26m
    expect(sectorAt(-5, 300)).toBe("aheadLeft");
    expect(sectorAt(355, 300)).toBe("aheadLeft"); // same angle, pre-normalized
    expect(sectorAt(5, 60)).toBe("ahead"); // lateral ≈ 5m
    expect(sectorAt(176, 300)).toBe("behindRight");
    expect(sectorAt(184, 300)).toBe("behindLeft");
    expect(sectorAt(90, 5000)).toBe("right"); // pure sides are untouched
  });
});

describe("distance phrasing", () => {
  test("metric table", () => {
    expect(distancePhrase(37, true)).toBe("40 meters");
    expect(distancePhrase(152, true)).toBe("150 meters");
    expect(distancePhrase(980, true)).toBe("1.0 kilometers");
    expect(distancePhrase(1840, true)).toBe("1.8 kilometers");
  });
  test("imperial table", () => {
    expect(distancePhrase(20, false)).toBe("70 feet");
    expect(distancePhrase(152, false)).toBe("500 feet");
    expect(distancePhrase(2000, false)).toBe("1.2 miles");
  });
});

describe("describeSpotLocation", () => {
  test("the user's own examples come out right", () => {
    // Walking north, spot 152m behind on the left (bearing ~225 from user).
    const u = from(152, 45); // user is NE of spot → spot is SW of user
    expect(
      describeSpotLocation({
        spotLat: SCOOP.lat, spotLng: SCOOP.lng,
        userLat: u.lat, userLng: u.lng,
        courseDeg: 0, anchor: "at 23 Broadway", metric: false,
      }),
    ).toBe("Back 500 feet on your left, at 23 Broadway.");

    // Walking north, spot 100m ahead-right.
    const u2 = from(100, 205); // user SSW of spot → spot at bearing ~25
    expect(
      describeSpotLocation({
        spotLat: SCOOP.lat, spotLng: SCOOP.lng,
        userLat: u2.lat, userLng: u2.lng,
        courseDeg: 0, anchor: "a large black building", metric: true,
      }),
    ).toBe("Coming up in 100 meters on your right — a large black building.");
  });

  test("no course falls back to cardinal, never guesses a side", () => {
    const u = from(200, 225); // spot is NE of user
    const text = describeSpotLocation({
      spotLat: SCOOP.lat, spotLng: SCOOP.lng,
      userLat: u.lat, userLng: u.lng,
      courseDeg: null, anchor: null, metric: true,
    });
    expect(text).toBe("About 200 meters to the northeast.");
  });

  test("standing at the spot", () => {
    expect(
      describeSpotLocation({
        spotLat: SCOOP.lat, spotLng: SCOOP.lng,
        userLat: SCOOP.lat, userLng: SCOOP.lng,
        courseDeg: null, anchor: null, metric: true,
      }),
    ).toBe("Right here.");
    const u = from(10, 270); // spot 10m east of user, walking north
    expect(
      describeSpotLocation({
        spotLat: SCOOP.lat, spotLng: SCOOP.lng,
        userLat: u.lat, userLng: u.lng,
        courseDeg: 0, anchor: null, metric: true,
      }),
    ).toBe("Right here on your right.");
  });

  test("dead ahead and dead behind", () => {
    const ahead = from(300, 180); // user south of spot, walking north
    expect(
      describeSpotLocation({
        spotLat: SCOOP.lat, spotLng: SCOOP.lng,
        userLat: ahead.lat, userLng: ahead.lng,
        courseDeg: 0, anchor: null, metric: true,
      }),
    ).toBe("Coming up in 300 meters, straight ahead.");
    expect(
      describeSpotLocation({
        spotLat: SCOOP.lat, spotLng: SCOOP.lng,
        userLat: ahead.lat, userLng: ahead.lng,
        courseDeg: 180, anchor: null, metric: true,
      }),
    ).toBe("300 meters behind you.");
  });
});
