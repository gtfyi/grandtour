import { expect, test } from "bun:test";
import { createSpeechOutput } from "../src/speech";

function setup() {
  let pendingTimer: (() => void) | undefined;
  const utterances: SpeechSynthesisUtterance[] = [];
  const synth = {
    speaking: false, pending: false, paused: false,
    getVoices: () => [],
    speak: (utterance: SpeechSynthesisUtterance) => { utterances.push(utterance); synth.speaking = true; },
    cancel: () => { synth.speaking = false; },
    pause: () => { synth.paused = true; },
    resume: () => { synth.paused = false; },
  };
  const output = createSpeechOutput(synth, (text) => ({ text }) as SpeechSynthesisUtterance, {
    schedule: ((callback: () => void) => { pendingTimer = callback; return 1; }) as typeof setTimeout,
    cancel: (() => { pendingTimer = undefined; }) as typeof clearTimeout,
  });
  const events = { starts: 0, ends: 0, error: "" };
  const callbacks = { start: () => { events.starts++; }, end: () => { events.ends++; }, error: (message: string) => { events.error = message; } };
  return { output, synth, utterances, events, callbacks, timeout: () => pendingTimer?.() };
}

test("a silently stalled engine reports an error and late callbacks cannot complete it", () => {
  const { output, utterances, events, callbacks, timeout } = setup();
  output.speak("A story.", "en", callbacks);
  timeout();
  expect(events.error).toBe("synthesis-start-timeout");
  utterances[0]!.onstart!(new Event("start") as SpeechSynthesisEvent);
  utterances[0]!.onend!(new Event("end") as SpeechSynthesisEvent);
  expect(events.starts).toBe(0);
  expect(events.ends).toBe(0);
  expect(output.resume()).toBe(false);
});

test("paused startup waits for resume before timing out", () => {
  const { output, events, callbacks, timeout } = setup();
  output.speak("A story.", "en", callbacks);
  output.pause();
  timeout();
  expect(events.error).toBe("");
  expect(output.resume()).toBe(true);
  timeout();
  expect(events.error).toBe("synthesis-start-timeout");
});
