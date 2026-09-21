import { describe, expect, test } from "bun:test";
import { TrackExport } from "@grandtour/shared";
import rawBundle from "./fixtures/sample.grandtour.json";
import { computeNearby } from "../src/nearby";
import { TourPlayback } from "../src/TourPlayback";

const bundle = TrackExport.parse(rawBundle);
const anchor = bundle.spots[0]!.spot.trigger.center!;
const nearby = computeNearby(bundle.track, bundle.spots, anchor, 0)
  .filter((n) => n.content?.audioUrl).slice(0, 2).map((n) => ({ ...n, triggered: true }));

function setup() {
  const player = new TourPlayback(undefined, { gapSeconds: 0 });
  const audio = {
    src: "", currentTime: 0, plays: 0, pauses: 0,
    play: () => { audio.plays++; player.onPlay(); return Promise.resolve(); },
    pause: () => { audio.pauses++; player.onPause(); },
    load: () => {},
  };
  player.attach(audio);
  return { player, audio };
}

describe("shared tour narration", () => {
  test("manual selection stays silent; Play loads that recording without starting automatic touring", () => {
    const { player, audio } = setup();
    player.select(nearby[1]!);
    expect(audio.plays).toBe(0);
    expect(player.getSnapshot().source).toBeNull();
    player.resume(false);
    expect(audio.src).toBe(nearby[1]!.content!.audioUrl!);
    expect(audio.plays).toBe(1);
    expect(player.getSnapshot().playing).toBe(true);
    expect(player.getSnapshot().running).toBe(false);
    player.next(nearby);
    player.ended();
    expect(audio.plays).toBe(1);
  });
  test("a manually chosen story can temporarily replace narration without ending the tour", () => {
    const { player } = setup();
    player.start([nearby[0]!]);
    player.play(nearby[1]!, true);
    expect(player.getSnapshot().item!.spot.id).toBe(nearby[1]!.spot.id);
    expect(player.getSnapshot().running).toBe(true);
    player.ended();
    expect(player.getSnapshot().item).toBeNull();
    expect(player.getSnapshot().running).toBe(true);
  });
  test("previewing and closing a story does not mark it heard", () => {
    const { player, audio } = setup();
    player.select(nearby[0]!);
    player.select(nearby[1]!);
    player.stop();
    expect(audio.plays).toBe(0);
    expect(player.hasHeard(nearby[0]!.spot.id)).toBe(false);
    expect(player.hasHeard(nearby[1]!.spot.id)).toBe(false);
  });
  test("Play starts a triggered clip synchronously and keeps it through proximity changes", () => {
    const { player, audio } = setup();
    player.start(nearby);
    expect(audio.plays).toBe(1);
    expect(audio.src).toBe(nearby[0]!.content!.audioUrl!);
    expect(player.getSnapshot().playing).toBe(true);
    player.next([...nearby].reverse());
    expect(audio.plays).toBe(1);
    expect(player.getSnapshot().item!.spot.id).toBe(nearby[0]!.spot.id);
  });
  test("finished stories are not replayed; the next in-range story can play", () => {
    const { player, audio } = setup();
    player.start(nearby);
    player.ended();
    player.next(nearby);
    expect(audio.plays).toBe(2);
    expect(player.getSnapshot().item!.spot.id).toBe(nearby[1]!.spot.id);
    player.ended();
    expect(player.next(nearby)).toBe(false);
  });
  test("pause/resume preserves the story and transcript, reset allows a new run", () => {
    const { player, audio } = setup();
    player.start(nearby);
    audio.currentTime = 4;
    player.onTime();
    player.pause();
    expect(player.getSnapshot().playing).toBe(false);
    expect(player.getSnapshot().currentMs).toBe(4000);
    player.start(nearby);
    expect(audio.currentTime).toBe(4);
    expect(player.getSnapshot().playing).toBe(true);
    player.reset();
    expect(player.getSnapshot().item).toBeNull();
    player.start(nearby);
    expect(player.getSnapshot().item!.spot.id).toBe(nearby[0]!.spot.id);
  });
  test("browser rejection is visible and retry plays the same narration", async () => {
    const { player, audio } = setup();
    audio.play = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
    player.start(nearby);
    await Promise.resolve();
    expect(player.getSnapshot().error).toContain("Press Play narration");
    expect(player.getSnapshot().playing).toBe(false);
    expect(player.next(nearby)).toBe(false);
    audio.play = () => { player.onPlay(); return Promise.resolve(); };
    player.resume();
    expect(player.getSnapshot().error).toBeNull();
    expect(player.getSnapshot().playing).toBe(true);
  });
  test("a stale rejected play cannot overwrite a newer story", async () => {
    const { player, audio } = setup();
    let reject!: (e: Error) => void;
    audio.play = () => new Promise<void>((_, r) => { reject = r; });
    player.play(nearby[0]!);
    audio.play = () => { player.onPlay(); return Promise.resolve(); };
    player.play(nearby[1]!);
    reject(new Error("interrupted"));
    await Promise.resolve();
    expect(player.getSnapshot().error).toBeNull();
    expect(player.getSnapshot().playing).toBe(true);
  });
  test("no narration outside trigger range; prime audio for later arrivals", () => {
    const { player, audio } = setup();
    player.start(nearby.map((n) => ({ ...n, triggered: false })));
    expect(audio.src).toStartWith("data:audio/wav");
    expect(player.getSnapshot().item).toBeNull();
    player.next(nearby);
    expect(audio.src).toBe(nearby[0]!.content!.audioUrl!);
  });
  test("missing audio does not block automatic playable candidates", () => {
    const { player } = setup();
    player.start([{ ...nearby[0]!, content: null }, nearby[1]!]);
    expect(player.getSnapshot().item!.spot.id).toBe(nearby[1]!.spot.id);
  });
  test("starting a drive dismisses a text-only selection", () => {
    const { player } = setup();
    player.play({ ...nearby[0]!, content: null });
    player.start([nearby[1]!]);
    expect(player.getSnapshot().item!.spot.id).toBe(nearby[1]!.spot.id);
  });
  test("leaving the preview stops audio and ignores pending failures", async () => {
    const { player, audio } = setup();
    audio.play = () => Promise.reject(new Error("interrupted"));
    player.start(nearby);
    const before = audio.pauses;
    player.attach(null);
    await Promise.resolve();
    expect(audio.pauses).toBe(before + 1);
    expect(player.getSnapshot().error).toBeNull();
  });
});

describe("device voice narration", () => {
  function spokenSetup() {
    let callbacks: import("../src/speech").SpeechCallbacks;
    const speech = {
      text: "", starts: 0, pauses: 0, resumes: 0, cancels: 0,
      speak(text: string, _locale: string, events: import("../src/speech").SpeechCallbacks) {
        speech.text = text; speech.starts++; callbacks = events; events.start();
      },
      pause: () => { speech.pauses++; },
      resume: () => { speech.resumes++; },
      cancel: () => { speech.cancels++; },
    };
    const player = new TourPlayback(speech, { gapSeconds: 0 });
    const audio = { src: "", currentTime: 0, play: () => Promise.resolve(), pause: () => player.onPause(), load: () => {} };
    player.attach(audio);
    const scripted = { ...nearby[0]!, content: { ...nearby[0]!.content!, audioUrl: null } };
    return { player, speech, audio, scripted, finish: () => callbacks.end(), fail: (reason = "failed") => callbacks.error(reason) };
  }
  test("manual Play speaks a selected script; pause and resume keep it in manual playback", () => {
    const { player, speech, scripted, finish } = spokenSetup();
    player.select(scripted);
    expect(speech.starts).toBe(0);
    player.resume(false);
    expect(speech.starts).toBe(1);
    expect(speech.text).toBe(scripted.content.document!.text);
    player.pause();
    player.resume(false);
    expect(speech.starts).toBe(1);
    expect(player.getSnapshot().playing).toBe(true);
    expect(player.getSnapshot().running).toBe(false);
    finish();
    expect(player.getSnapshot().item).toBeNull();
  });
  test("a dropped utterance restarts on Play instead of claiming speech resumed", () => {
    const { player, speech, scripted } = spokenSetup();
    player.select(scripted);
    player.resume(false);
    player.pause();
    speech.resume = () => false;
    player.resume(false);
    expect(speech.starts).toBe(2);
    expect(player.getSnapshot().running).toBe(false);
  });
  test("Play while speech is pending does not claim it has started", () => {
    const { player, speech, scripted } = spokenSetup();
    let start!: () => void;
    speech.speak = (_text, _locale, callbacks) => { start = callbacks.start; };
    player.select(scripted);
    player.resume(false);
    player.resume(false);
    expect(player.getSnapshot().playing).toBe(false);
    start();
    expect(player.getSnapshot().playing).toBe(true);
  });
  test("a triggered text-only story speaks its published script and becomes heard on completion", () => {
    const { player, speech, scripted, finish } = spokenSetup();
    player.start([scripted]);
    expect(speech.text).toBe(scripted.content.document!.text);
    expect(player.getSnapshot().source).toBe("device");
    expect(player.getSnapshot().playing).toBe(true);
    expect(player.isAvailable(scripted)).toBe(false);
    finish();
    expect(player.getSnapshot().item).toBeNull();
    expect(player.next([scripted])).toBe(false);
    player.reset();
    expect(player.isAvailable(scripted)).toBe(true);
  });
  test("pause/resume preserves speech completion callbacks and does not restart the script", () => {
    const { player, speech, scripted, finish } = spokenSetup();
    player.start([scripted]);
    player.pause();
    expect(speech.pauses).toBe(1);
    expect(player.getSnapshot().playing).toBe(false);
    player.start([scripted]);
    expect(speech.resumes).toBe(1);
    expect(speech.starts).toBe(1);
    expect(player.getSnapshot().playing).toBe(true);
    finish();
    expect(player.getSnapshot().item).toBeNull();
  });
  test("a failed recording falls back to the same script without leaving playback stuck", async () => {
    const { player, speech, audio } = spokenSetup();
    audio.play = () => Promise.reject(new Error("404"));
    player.start(nearby);
    await Promise.resolve();
    expect(speech.text).toBe(nearby[0]!.content!.document!.text);
    expect(player.getSnapshot().source).toBe("device");
    expect(player.getSnapshot().playing).toBe(true);
    player.onAudioEnded(); // Late event from the failed recording must not end speech.
    expect(player.getSnapshot().item).not.toBeNull();
  });
  test("leaving the tour cancels speech and ignores late completion", () => {
    const { player, speech, scripted, finish } = spokenSetup();
    player.start([scripted]);
    const before = speech.cancels;
    player.attach(null);
    expect(speech.cancels).toBe(before + 1);
    finish();
    expect(player.getSnapshot().item?.spot.id).toBe(scripted.spot.id);
  });
  test("device voice errors are visible and retry restarts the utterance", () => {
    const { player, speech, scripted, fail } = spokenSetup();
    player.start([scripted]); fail();
    expect(player.getSnapshot().error).toContain("Play narration");
    player.resume();
    expect(speech.starts).toBe(2);
    expect(player.getSnapshot().error).toBeNull();
    expect(player.getSnapshot().playing).toBe(true);
  });
  test("an interrupted voice pauses the tour and ignores its late completion", () => {
    const { player, scripted, fail, finish } = spokenSetup();
    player.start([scripted, nearby[1]!]);
    fail("interrupted");
    expect(player.getSnapshot().error).toContain("was interrupted (interrupted)");
    expect(player.getSnapshot().running).toBe(false);
    finish();
    expect(player.getSnapshot().item?.spot.id).toBe(scripted.spot.id);
    expect(player.hasHeard(scripted.spot.id)).toBe(false);
    player.resume();
    finish();
    expect(player.getSnapshot().item?.spot.id).toBe(nearby[1]!.spot.id);
    expect(player.getSnapshot().running).toBe(true);
  });
  test("skipping a failed voice restarts automatic playback for subsequent arrivals", () => {
    const { player, scripted, fail } = spokenSetup();
    player.start([scripted, nearby[1]!]);
    fail("synthesis-failed");
    player.play(nearby[1]!, true);
    expect(player.getSnapshot().running).toBe(true);
    expect(player.getSnapshot().error).toBeNull();
    player.ended();
    const later = { ...nearby[0]!, spot: { ...nearby[0]!.spot, id: "later-arrival" } };
    player.next([later]);
    expect(player.getSnapshot().item?.spot.id).toBe("later-arrival");
  });
});

describe("current-location eligibility", () => {
  test("a story passed during narration expires instead of playing afterwards", () => {
    const { player, audio } = setup();
    player.start([nearby[0]!]);
    player.next([nearby[1]!]);
    player.next([{ ...nearby[1]!, triggered: false }]);
    expect(player.getSnapshot().item?.spot.id).toBe(nearby[0]!.spot.id);
    player.ended();
    expect(player.getSnapshot().item).toBeNull();
    expect(audio.plays).toBe(1);
    // It was skipped, not heard. A later genuine visit can play it.
    expect(player.hasHeard(nearby[1]!.spot.id)).toBe(false);
    player.next([nearby[1]!]);
    expect(player.getSnapshot().item?.spot.id).toBe(nearby[1]!.spot.id);
  });
  test("the next story starts only if still in range when narration ends", () => {
    const { player, audio } = setup();
    player.start(nearby);
    player.next([nearby[1]!]);
    player.ended();
    expect(player.getSnapshot().item?.spot.id).toBe(nearby[1]!.spot.id);
    expect(audio.plays).toBe(2);
  });
  test("movement while paused expires candidates before resume", () => {
    const { player, audio } = setup();
    player.start(nearby);
    player.pause();
    player.next([]);
    player.ended();
    player.resume();
    expect(player.getSnapshot().item).toBeNull();
    expect(audio.plays).toBe(1);
  });
  test("ending the route outside all triggers does not drain a backlog", () => {
    const { player, audio } = setup();
    player.start(nearby);
    player.next([]);
    player.ended();
    player.resume();
    expect(player.getSnapshot().item).toBeNull();
    expect(audio.plays).toBe(1);
  });
  test("reset clears eligibility and duplicate observations cannot replay a heard story", () => {
    const { player, audio } = setup();
    player.start([nearby[0]!]);
    player.next([nearby[1]!, nearby[1]!]);
    player.ended();
    player.ended();
    expect(player.getSnapshot().item).toBeNull();
    expect(audio.plays).toBe(2);
    player.reset();
    player.resume();
    expect(player.getSnapshot().item).toBeNull();
  });
});

describe("pause between automatic stories", () => {
  function gapSetup() {
    let now = 0;
    let pending: (() => void) | null = null;
    let delay = 0;
    const player = new TourPlayback(null, {
      now: () => now,
      schedule: ((callback: () => void, ms: number) => { pending = callback; delay = ms; return 1; }) as unknown as typeof setTimeout,
      cancel: (() => { pending = null; }) as typeof clearTimeout,
    });
    const audio = { src: "", currentTime: 0, play: () => Promise.resolve(), pause: () => {}, load: () => {} };
    player.attach(audio);
    return { player, advance: (ms: number) => { now += ms; }, fire: () => { const callback = pending; pending = null; callback?.(); }, delay: () => delay };
  }
  test("default pause measures 3 seconds after a long recording ends", () => {
    const { player, advance, fire, delay } = gapSetup();
    player.start(nearby);
    advance(600_000);
    player.ended();
    expect(player.getSnapshot().item).toBeNull();
    expect(delay()).toBe(3_000);
    advance(2_999);
    player.next(nearby);
    expect(player.getSnapshot().item).toBeNull();
    expect(delay()).toBe(1);
    advance(1);
    fire();
    expect(player.getSnapshot().item?.spot.id).toBe(nearby[1]!.spot.id);
  });
  test("the timer expires a departed spot and respects pause and setting changes", () => {
    const { player, advance, fire, delay } = gapSetup();
    player.start(nearby);
    player.ended();
    player.setGapSeconds(30);
    expect(delay()).toBe(30_000);
    player.next(nearby.map((item) => ({ ...item, triggered: false })));
    advance(30_000);
    fire();
    expect(player.getSnapshot().item).toBeNull();
    player.next(nearby);
    expect(player.getSnapshot().item?.spot.id).toBe(nearby[1]!.spot.id);
    player.reset();
    player.start(nearby);
    player.ended();
    player.pause();
    advance(30_000);
    fire();
    expect(player.getSnapshot().item).toBeNull();
    expect(player.getSnapshot().running).toBe(false);
  });
});

describe("the phone's scheduling defaults", () => {
  const fairfax = { lat: 37.9871, lng: -122.5889 };
  const fence = [
    { lat: fairfax.lat + 0.01, lng: fairfax.lng - 0.01 }, { lat: fairfax.lat + 0.01, lng: fairfax.lng + 0.01 },
    { lat: fairfax.lat - 0.01, lng: fairfax.lng + 0.01 }, { lat: fairfax.lat - 0.01, lng: fairfax.lng - 0.01 },
  ];
  const ambient = { ...nearby[1]!, spot: { ...nearby[1]!.spot, id: "ambient", trigger: { kind: "area" as const, center: fairfax, radiusM: 0, region: fence } }, distanceM: 0 };
  function timed(gapSeconds?: number) {
    let clock = 1_000_000;
    const delays: number[] = [];
    const player = new TourPlayback(null, {
      gapSeconds, now: () => clock,
      schedule: ((cb: () => void, delay: number) => { delays.push(delay); return setTimeout(cb, 0) as unknown as ReturnType<typeof setTimeout>; }) as typeof setTimeout,
    });
    const audio = { src: "", currentTime: 0, play: () => Promise.resolve(), pause: () => {}, load: () => {} };
    player.attach(audio);
    return { player, audio, delays, advance: (ms: number) => { clock += ms; } };
  }

  test("the pause after a story is 3 seconds by default, and can be set to none", () => {
    const { player, delays } = timed();
    player.start(nearby);
    player.onAudioEnded();
    player.next(nearby);
    expect(delays.at(-1)).toBe(3000);
    player.setGapSeconds(0);
    expect(delays.length).toBeGreaterThan(0);
    const { player: p2, delays: d2 } = timed(0);
    p2.start(nearby);
    p2.onAudioEnded();
    p2.next(nearby);
    expect(d2).toEqual([]);
  });

  test("an arrival outranks an ambient story you are standing inside, which plays in the next gap", () => {
    const { player, audio } = timed(0);
    // Ambient sorts first by distance (0 m), but a point arrival still wins.
    player.start([ambient, nearby[0]!]);
    expect(player.getSnapshot().item?.spot.id).toBe(nearby[0]!.spot.id);
    expect(audio.src).toBe(nearby[0]!.content!.audioUrl!);
    player.onAudioEnded();
    player.next([ambient]);
    expect(player.getSnapshot().item?.spot.id).toBe("ambient");
  });

  test("a sequence's later part is held until the earlier part is heard, but a manual tap always plays", () => {
    const heard = new Set<string>();
    const player = new TourPlayback(null, {
      gapSeconds: 0,
      released: (item) => item.spot.id !== "part-2" || heard.has("part-1"),
    });
    player.attach({ src: "", currentTime: 0, play: () => Promise.resolve(), pause: () => {}, load: () => {} });
    const part2 = { ...nearby[1]!, spot: { ...nearby[1]!.spot, id: "part-2" } };
    player.start([part2]);
    expect(player.getSnapshot().item).toBeNull();
    player.play(part2);
    expect(player.getSnapshot().item?.spot.id).toBe("part-2");
    player.stop();
    heard.add("part-1");
    player.next([{ ...part2, spot: { ...part2.spot, id: "part-2b" } }]);
    expect(player.getSnapshot().item?.spot.id).toBe("part-2b");
  });
});

describe("the phone's scheduler on the web", () => {
  /** A position `westM` metres west of a spot's centre, so the spot lies dead ahead on a course of 90°. */
  const west = (center: { lat: number; lng: number }, westM: number) =>
    ({ lat: center.lat, lng: center.lng - westM / (111_320 * Math.cos((center.lat * Math.PI) / 180)) });
  function fixed(options: { gapSeconds?: number } = {}) {
    let clock = 1_000_000;
    const player = new TourPlayback(null, { gapSeconds: options.gapSeconds ?? 0, now: () => clock });
    const audio = { src: "", currentTime: 0, play: () => Promise.resolve(), pause: () => {}, load: () => {} };
    player.attach(audio);
    return { player, audio, advance: (ms: number) => { clock += ms; } };
  }
  // A 45 s recording: lead window = min(45 + 4, 60) + 5 = 54 s of travel.
  const story = { ...nearby[1]!, triggered: false };
  const center = story.spot.trigger.center!;

  test("a story ahead starts inside its lead window, before its trigger, and not from farther away", () => {
    const { player } = fixed();
    const walking = (westM: number) => ({ location: { ...west(center, westM), speedMps: 1.4 }, courseDeg: 90, mode: "walking" });
    player.start([story], walking(110));
    expect(player.getSnapshot().item).toBeNull();
    expect(player.getSnapshot().upNext?.spot.id).toBe(story.spot.id);
    expect(player.next([story], walking(70))).toBe(true);
    expect(player.getSnapshot().item?.spot.id).toBe(story.spot.id);
  });

  test("standing still, nothing starts early; a spot passed on the way stays out of Up next", () => {
    const { player } = fixed();
    const still = { location: { ...west(center, 70), speedMps: 0 }, courseDeg: 90, mode: "walking" };
    player.start([story], still);
    expect(player.getSnapshot().item).toBeNull();
    const behind = { location: { ...west(center, -80), speedMps: 1.4 }, courseDeg: 90, mode: "walking" };
    player.next([story], behind);
    expect(player.getSnapshot().upNext).toBeNull();
  });

  test("Up next is the scheduler's target while a story plays, and clears when the tour stops", () => {
    const { player } = fixed();
    player.start(nearby);
    expect(player.getSnapshot().item?.spot.id).toBe(nearby[0]!.spot.id);
    expect(player.getSnapshot().upNext?.spot.id).toBe(nearby[1]!.spot.id);
    player.pause();
    expect(player.getSnapshot().upNext).toBeNull();
  });

  test("an evergreen story returns after the phone's cooldown; a series story never auto-replays", () => {
    const { player, advance } = fixed();
    const series = { ...nearby[1]!, track: { ...nearby[1]!.track, lifecycle: "series" as const } };
    player.start([nearby[0]!, series]);
    player.ended();
    expect(player.getSnapshot().item?.spot.id).toBe(series.spot.id);
    player.ended();
    advance(7 * 3600 * 1000);
    expect(player.next([nearby[0]!, series])).toBe(true);
    expect(player.getSnapshot().item?.spot.id).toBe(nearby[0]!.spot.id);
    player.ended();
    expect(player.next([series])).toBe(false);
  });

  test("a heard story fills the wait only when it ends before the fresh target opens", () => {
    const { player, advance } = fixed();
    const heard = { ...nearby[0]!, triggered: true };
    const fresh = { ...nearby[1]!, triggered: false };
    const at = (westM: number) => ({ location: { ...west(center, westM), speedMps: 1.4 }, courseDeg: 90, mode: "walking" });
    player.start([heard], at(700));
    player.ended();
    advance(24 * 3600 * 1000);
    // 700 m at 1.4 m/s: the target opens in ~424 s, so the 45 s filler fits.
    expect(player.next([heard, fresh], at(700))).toBe(true);
    expect(player.getSnapshot().item?.spot.id).toBe(heard.spot.id);
    expect(player.getSnapshot().upNext?.spot.id).toBe(fresh.spot.id);
    player.ended();
    // 120 m out the target opens in ~10 s: the filler would delay it, so nothing starts.
    expect(player.next([heard, fresh], at(120))).toBe(false);
  });
});

describe("prefetched recordings", () => {
  test("a recording plays from its prefetched copy when there is one", () => {
    const player = new TourPlayback(undefined, {
      gapSeconds: 0,
      resolveAudio: (url) => (url === nearby[0]!.content!.audioUrl ? "blob:prefetched" : url),
    });
    const audio = {
      src: "", currentTime: 0,
      play: () => { player.onPlay(); return Promise.resolve(); },
      pause: () => { player.onPause(); },
      load: () => {},
    };
    player.attach(audio);
    player.play(nearby[0]!);
    expect(audio.src).toBe("blob:prefetched");
    player.play(nearby[1]!);
    expect(audio.src).toBe(nearby[1]!.content!.audioUrl!);
  });
});
