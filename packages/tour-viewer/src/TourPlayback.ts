import type { NearbySpot, SchedulerContext, SchedulerLocation } from "@grandtour/shared";
import { SCHEDULER, SpotScheduler, narrationDurationS, schedulerContext } from "@grandtour/shared";
import { browserSpeech, type SpeechOutput } from "./speech";
import { isArea, pickAmbient } from "./eligibility";
import { sessionHistory, type PlayHistory } from "./playHistory";

export const canNarrate = (item: NearbySpot) => !!(item.content?.audioUrl || item.content?.document?.text.trim());
type AudioOutput = Pick<HTMLAudioElement, "src" | "currentTime" | "play" | "pause" | "load">;

/**
 * The fix a decision runs on — what the phone's `schedulerContext` reads
 * from its location manager. Anything omitted keeps the scheduler's
 * defaults (no position: arrivals only; walking).
 */
export interface Fix {
  location?: SchedulerLocation | null;
  courseDeg?: number | null;
  /** walking, driving, … — the phone's activity mode (`ActivityModeDetector`). */
  mode?: string;
  trackIdToSlug?: Record<string, string>;
}
interface PlaybackOptions {
  /** Pause after a story ends before the next automatic start; the phone's default is 3 s. */
  gapSeconds?: number;
  /** What counts as already heard. Defaults to a per-session set. */
  history?: PlayHistory;
  /** Whole-track rules the snapshot cannot see (a sequence's earlier parts). Default: everything is released. */
  released?: (item: NearbySpot) => boolean;
  /** Where a recording is loaded from: a prefetched copy when there is one (`AudioPrefetch`). */
  resolveAudio?: (url: string) => string;
  now?: () => number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}
export interface PlaybackState {
  item: NearbySpot | null;
  /** The scheduler's target while the tour runs — what "Up next" shows. */
  upNext: NearbySpot | null;
  running: boolean;
  playing: boolean;
  currentMs: number;
  error: string | null;
  source: "recording" | "device" | null;
}

/**
 * Location-aware playback with recorded narration and a published-script
 * voice fallback. Automatic starts are the phone's `decideWander`
 * (ios/Sources/TourViewModel.swift) on the web: the same `SpotScheduler`
 * names the target and what to start, the same gap planner fills the wait
 * with an ambient area story, the same pause runs after every story, and
 * the same history rules decide what may play again. Nothing preempts:
 * a start only ever happens against an idle player.
 */
export class TourPlayback {
  private audio: AudioOutput | null = null;
  private readonly scheduler = new SpotScheduler();
  private nearby: NearbySpot[] = [];
  private fix: Fix = {};
  private startedAt = 0;
  private history: PlayHistory;
  private released: (item: NearbySpot) => boolean;
  private readonly resolveAudio: (url: string) => string;
  private listeners = new Set<() => void>();
  private generation = 0;
  private speechStarted = false;
  private state: PlaybackState = { item: null, upNext: null, running: false, playing: false, currentMs: 0, error: null, source: null };

  private gapSeconds: number;
  private finishedAt: number | null = null;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;

  constructor(private speech: SpeechOutput | null = browserSpeech(), options: PlaybackOptions = {}) {
    this.gapSeconds = options.gapSeconds ?? 3;
    this.now = options.now ?? Date.now;
    this.history = options.history ?? sessionHistory(this.now);
    this.released = options.released ?? (() => true);
    this.resolveAudio = options.resolveAudio ?? ((url) => url);
    this.schedule = options.schedule ?? ((callback, delay, ...args) => setTimeout(callback, delay, ...args));
    this.cancel = options.cancel ?? ((timer) => clearTimeout(timer));
  }
  /** Swap what counts as heard — a demo keeps its own, in memory, and hands the real one back after. */
  setHistory = (history: PlayHistory) => { this.history = history; };
  setGapSeconds = (seconds: number) => {
    this.gapSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 3;
    this.clearGapTimer();
    this.decide();
  };
  private clearGapTimer() {
    if (this.gapTimer !== null) this.cancel(this.gapTimer);
    this.gapTimer = null;
  }
  getSnapshot = () => this.state;
  hasHeard = (id: string) => this.history.has(id);
  /** Ever heard, cooldown or not — what a sequence's later parts wait for. */
  heard = (id: string) => this.history.heard(id);
  isAvailable = (item: NearbySpot) => canNarrate(item) && !this.history.has(item.spot.id)
    && item.spot.id !== this.state.item?.spot.id && this.released(item);
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private update(patch: Partial<PlaybackState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  private fail(error: string) {
    // A failed utterance may still deliver a late end event. Keep the story and
    // current location for an explicit retry, without counting it as successfully heard.
    this.generation++;
    this.update({ playing: false, running: false, error });
  }
  attach = (audio: AudioOutput | null) => {
    this.clearGapTimer();
    if (!audio) this.update({ running: false, upNext: null });
    this.generation++;
    this.audio?.pause();
    if (!audio) this.speech?.cancel();
    this.audio = audio;
  };
  private requestPlay() {
    if (!this.audio) return;
    const generation = ++this.generation;
    this.update({ error: null });
    this.audio.play().catch((error: unknown) => {
      if (generation !== this.generation) return;
      const blocked = error instanceof Error && error.name === "NotAllowedError";
      if (!blocked && this.speakScript()) return;
      this.fail(blocked
        ? "Your browser paused audio. Press Play narration to enable it."
        : "Audio could not be played. Check your connection and press Play narration to retry.");
    });
  }
  private primeAudio() {
    if (!this.audio) return;
    this.audio.src = SILENCE;
    this.audio.play().catch(() => {});
  }
  private speakScript(): boolean {
    const item = this.state.item;
    const text = item?.content?.document?.text.trim();
    if (!text) return false;
    if (!this.speech) {
      this.update({ source: "device" });
      this.fail("Device voice is unavailable in this browser. Open this tour in a browser with speech support, or choose a recorded story.");
      return true;
    }
    const generation = ++this.generation;
    this.speechStarted = false;
    this.update({ source: "device", playing: false, error: null, currentMs: 0 });
    this.audio?.pause();
    // A first story can use speech. Unlock recorded output in the same gesture.
    this.primeAudio();
    const current = () => generation === this.generation;
    const failed = (reason: string) => {
      if (!current()) return;
      if (reason === "synthesis-start-timeout") {
        this.fail("Device voice did not start. Press Play narration to retry. If it still fails, reopen this tour in another browser.");
        return;
      }
      const interrupted = reason === "interrupted" || reason === "canceled";
      this.fail(`Device voice ${interrupted ? "was interrupted" : "could not continue"} (${reason}). Press Play narration to retry, or Next stop to skip this story.`);
    };
    try {
      this.speech.speak(text, item?.content?.locale ?? "en", {
        start: () => { if (current()) { this.speechStarted = true; this.update({ playing: true }); } },
        end: () => { if (current()) this.ended(); },
        error: failed,
      });
    } catch (error) { failed(error instanceof Error ? error.message : "unknown error"); }
    return true;
  }
  /** Selecting a marker/card previews it. Output starts only on explicit Play. */
  select = (item: NearbySpot) => {
    this.clearGapTimer();
    this.generation++;
    this.speech?.cancel();
    this.audio?.pause();
    this.speechStarted = false;
    this.update({ item, upNext: null, running: false, playing: false, currentMs: 0, error: null, source: null });
  };
  play = (item: NearbySpot, continueTour = this.state.running) => {
    this.clearGapTimer();
    this.generation++;
    this.speech?.cancel();
    this.audio?.pause();
    if (this.state.item && this.state.source && this.state.item.spot.id !== item.spot.id) {
      this.history.add(this.state.item.spot.id, { lifecycle: this.state.item.track.lifecycle });
    }
    this.startedAt = this.now();
    this.update({ item, running: continueTour, playing: false, currentMs: 0, error: null, source: null });
    if (!item.content?.audioUrl) { this.speakScript(); return; }
    if (!this.audio) return;
    this.update({ source: "recording" });
    this.audio.src = this.resolveAudio(item.content.audioUrl);
    this.requestPlay();
  };
  // ─── The decision (the phone's decideWander) ─────────────────────────────

  /** Narratable, once each — what the phone hands its scheduler. */
  private candidates(): NearbySpot[] {
    const seen = new Set<string>();
    return this.nearby.filter((n) => canNarrate(n) && !seen.has(n.spot.id) && seen.add(n.spot.id));
  }
  /** Seconds of narration left — the phone's `playerBusyForS`: measured for a recording, by the clock for a voice. */
  private busyForS(nowMs: number): number {
    const { item, source, currentMs } = this.state;
    if (!item || !source) return 0;
    const elapsedS = currentMs > 0 ? currentMs / 1000 : (nowMs - this.startedAt) / 1000;
    return Math.max(0, narrationDurationS(item) - elapsedS);
  }
  /** Everything the decision depends on, snapshotted now — the phone's `schedulerContext`. */
  private context(candidates: NearbySpot[]): SchedulerContext {
    const byId = new Map(candidates.map((c) => [c.spot.id, c]));
    const nowMs = this.now();
    return schedulerContext({
      location: this.fix.location ?? null,
      courseDeg: this.fix.courseDeg ?? null,
      mode: this.fix.mode ?? "walking",
      trackIdToSlug: this.fix.trackIdToSlug ?? {},
      nowS: nowMs / 1000,
      lastPlayedAtS: (id) => { const at = this.history.lastPlayedAt(id); return at == null ? null : at / 1000; },
      playCount: (id) => this.history.playCount(id),
      isEligible: (id) => { const item = byId.get(id); return item ? this.released(item) : true; },
      neverReplays: (id) => byId.get(id)?.track.lifecycle === "series",
      busyForS: this.busyForS(nowMs),
      nowPlayingId: this.state.item?.spot.id ?? null,
    });
  }
  /**
   * The gap planner's ambient candidate — the phone's `pickAmbientSpot`: an
   * area story whose fence contains the traveler, released, not
   * replay-blocked, and short enough to end before the target opens.
   */
  private ambient(candidates: NearbySpot[], budgetS: number | null, ctx: SchedulerContext): NearbySpot | null {
    const inside = candidates.filter((s) => {
      if (!isArea(s) || !s.triggered || !ctx.isEligible(s.spot.id)) return false;
      const last = ctx.lastPlayedAtS(s.spot.id);
      if (last != null && (ctx.neverReplays(s.spot.id) || ctx.nowS - last < SCHEDULER.replayCooldownS)) return false;
      return this.scheduler.fits(ctx.durationS(s), budgetS);
    });
    return pickAmbient(inside, ctx);
  }
  /**
   * Decide what the tour is heading for and, if the player is idle and the
   * pause has run out, what to start: the target once its window opens, a
   * filler that fits before it, else an ambient story for the gap. Runs on
   * every fix, when narration ends, when the pause expires, and on the
   * caller's poll between fixes. Returns true when something started.
   */
  decide = (): boolean => {
    if (!this.state.running) return false;
    const candidates = this.candidates();
    const ctx = this.context(candidates);
    const plan = this.scheduler.plan(candidates, ctx);
    if ((plan.target?.spot.id ?? null) !== (this.state.upNext?.spot.id ?? null)) this.update({ upNext: plan.target });
    if (this.state.item) return false;
    this.clearGapTimer();
    // Reconsider the current location when the pause expires; never reserve
    // a story that may be out of range by then.
    const remaining = this.finishedAt === null ? 0 : this.gapSeconds * 1000 - (this.now() - this.finishedAt);
    if (remaining > 0) {
      this.gapTimer = this.schedule(() => { this.gapTimer = null; this.decide(); }, remaining);
      return false;
    }
    const start = plan.playNow ?? this.ambient(candidates, plan.gapBudgetS, ctx);
    if (!start) return false;
    this.play(start);
    // Re-aim "Up next" past what just started, as the phone's next poll would.
    this.decide();
    return true;
  };
  private observe(nearby: NearbySpot[], fix?: Fix) {
    // Replace the snapshot on every fix. A visit is not a reservation to
    // play later: once outside its trigger, an unstarted story expires.
    this.nearby = nearby;
    if (fix) this.fix = fix;
  }
  /** A new fix (or the same one, re-decided). */
  next = (nearby: NearbySpot[], fix?: Fix) => { this.observe(nearby, fix); return this.decide(); };
  start = (nearby: NearbySpot[], fix?: Fix) => {
    this.update({ running: true });
    this.observe(nearby, fix);
    if (this.state.item && canNarrate(this.state.item)) { this.resume(); return; }
    if (this.state.item) this.finish();
    if (this.decide()) return;
    if (!this.state.item) this.primeAudio();
  };
  resume = (continueTour = true) => {
    this.update({ running: continueTour });
    if (!this.state.item) { this.decide(); return; }
    if (!canNarrate(this.state.item)) return;
    if (!this.state.source) { this.play(this.state.item, continueTour); return; }
    if (this.state.source === "device") {
      // A browser can lose a pending utterance without delivering an error.
      // Retry from this gesture instead of displaying a fictitious playing state.
      if (this.state.error || this.speech?.resume() === false) this.speakScript();
      else this.update({ playing: this.speechStarted });
      return;
    }
    if (!this.state.item.content?.audioUrl) { this.speakScript(); return; }
    if (this.state.error) this.audio?.load();
    this.requestPlay();
  };
  pause = () => {
    this.clearGapTimer();
    if (this.state.source === "device") this.speech?.pause();
    else { this.generation++; this.audio?.pause(); }
    this.update({ playing: false, running: false, upNext: null });
  };
  private finish() {
    if (this.state.item && this.state.source) {
      this.history.add(this.state.item.spot.id, { lifecycle: this.state.item.track.lifecycle });
      if (canNarrate(this.state.item)) this.finishedAt = this.now();
    }
    this.clearGapTimer();
    this.generation++;
    this.speech?.cancel();
    this.audio?.pause();
    this.update({ item: null, playing: false, currentMs: 0, error: null, source: null });
  }
  stop = () => { this.finish(); this.decide(); };
  reset = () => {
    this.update({ running: false, upNext: null });
    this.finish();
    this.history.clear();
    this.nearby = [];
    this.finishedAt = null;
  };
  ended = () => { if (this.state.item) this.stop(); };
  onAudioEnded = () => { if (this.state.source === "recording") this.ended(); };
  onPlay = () => { if (this.state.item && this.state.source === "recording") this.update({ playing: true, error: null }); };
  onPause = () => { if (this.state.source === "recording") this.update({ playing: false }); };
  onTime = () => { if (this.state.item && this.audio && this.state.source === "recording") this.update({ currentMs: this.audio.currentTime * 1000 }); };
  onError = () => {
    if (this.state.source !== "recording") return;
    if (this.speakScript()) return;
    if (this.state.item) this.fail("Audio could not be loaded. Press Play narration to retry.");
  };
}

// 100 ms of silence, 8-bit mono PCM at 8 kHz. This unlocks audio only on a user gesture.
const SILENCE = (() => {
  const bytes = new Uint8Array(844);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, text: string) => [...text].forEach((c, i) => { bytes[offset + i] = c.charCodeAt(0); });
  write(0, "RIFF"); view.setUint32(4, 836, true); write(8, "WAVEfmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  write(36, "data"); view.setUint32(40, 800, true); bytes.fill(128, 44);
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`;
})();
