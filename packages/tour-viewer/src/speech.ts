export interface SpeechCallbacks {
  start: () => void;
  end: () => void;
  error: (message: string) => void;
}

export interface SpeechOutput {
  speak: (text: string, locale: string, callbacks: SpeechCallbacks) => void;
  pause: () => void;
  /** False if the browser has lost the utterance and it must be restarted. */
  resume: () => boolean | void;
  cancel: () => void;
}

type Synth = Pick<SpeechSynthesis, "getVoices" | "speak" | "cancel" | "pause" | "resume" | "speaking" | "pending" | "paused">;
type Timers = { schedule: typeof setTimeout; cancel: typeof clearTimeout };

/** Kept separate from window so real engine stalls and stale callbacks can be tested. */
export function createSpeechOutput(synth: Synth, makeUtterance: (text: string) => SpeechSynthesisUtterance,
  timers: Timers = { schedule: (callback, delay, ...args) => setTimeout(callback, delay, ...args), cancel: (timer) => clearTimeout(timer) }): SpeechOutput {
  let utterance: SpeechSynthesisUtterance | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let armStart: (() => void) | null = null;
  const clearTimer = () => { if (timer !== null) timers.cancel(timer); timer = null; };
  const cancel = () => {
    generation++;
    clearTimer();
    armStart = null;
    utterance = null;
    if (synth.speaking || synth.pending) synth.cancel();
  };
  return {
    speak(text, locale, callbacks) {
      cancel();
      if (synth.paused) synth.resume();
      const session = generation;
      const language = locale.split("-")[0]!.toLowerCase();
      const voices = synth.getVoices().filter((voice) => voice.localService);
      const voice = voices.find((voice) => voice.lang.toLowerCase() === locale.toLowerCase())
        ?? voices.find((voice) => voice.lang.split("-")[0]!.toLowerCase() === language);
      let announcedStart = false;
      const next = makeUtterance(text);
      utterance = next;
      next.lang = locale;
      if (voice) next.voice = voice;
      let started = false;
      const current = () => generation === session && utterance === next;
      const start = () => {
        if (!current()) return;
        started = true;
        clearTimer();
        if (!announcedStart) { announcedStart = true; callbacks.start(); }
      };
      next.onstart = start;
      next.onboundary = start; // Some engines deliver boundaries but omit start.
      next.onend = () => {
        if (!current()) return;
        clearTimer();
        utterance = null;
        armStart = null;
        callbacks.end();
      };
      next.onerror = (event) => {
        if (!current()) return;
        cancel();
        callbacks.error(event.error);
      };
      armStart = () => {
        clearTimer();
        if (started) return;
        timer = timers.schedule(() => {
          if (!current()) return;
          cancel();
          callbacks.error("synthesis-start-timeout");
        }, 8000);
      };
      armStart();
      synth.speak(next);
    },
    pause: () => { clearTimer(); synth.pause(); },
    resume: () => {
      if (!utterance || (!synth.speaking && !synth.pending)) return false;
      synth.resume();
      armStart?.();
      return true;
    },
    cancel,
  };
}

/** Use the browser's normal system voice when a published script has no recording. */
export function browserSpeech(): SpeechOutput | null {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return null;
  return createSpeechOutput(window.speechSynthesis, (text) => new SpeechSynthesisUtterance(text));
}
