/// <reference lib="dom" />
import { describe, expect, it, vi } from "vitest";
import {
  TimerEffects,
  type TimerAudioContext,
  type TimerAudioNode,
  type TimerAudioParam,
  type TimerGain,
  type TimerOscillator,
  type TimerWakeLock
} from "../src/timerEffects";

function audioParam() {
  return {
    setValueAtTime: vi.fn(),
    exponentialRampToValueAtTime: vi.fn()
  } satisfies TimerAudioParam;
}

function audioNode() {
  const node: TimerAudioNode = {
    connect: vi.fn(() => node)
  };
  return node;
}

function audioFixture(state: AudioContextState = "suspended") {
  let ended: (() => void) | null = null;
  const destination = audioNode();
  const gain: TimerGain = {
    ...audioNode(),
    gain: audioParam()
  };
  const oscillator: TimerOscillator = {
    ...audioNode(),
    frequency: audioParam(),
    type: "sine",
    addEventListener: vi.fn((_type, listener) => {
      ended = listener;
    }),
    start: vi.fn(),
    stop: vi.fn()
  };
  const context: TimerAudioContext = {
    currentTime: 10,
    destination,
    state,
    close: vi.fn(async () => undefined),
    createGain: vi.fn(() => gain),
    createOscillator: vi.fn(() => oscillator),
    resume: vi.fn(async () => undefined)
  };
  return {
    context,
    oscillator,
    finish: () => ended?.()
  };
}

function wakeLockFixture() {
  let releaseListener: (() => void) | null = null;
  const wakeLock: TimerWakeLock = {
    released: false,
    addEventListener: vi.fn((_type, listener) => {
      releaseListener = listener;
    }),
    release: vi.fn(async () => {
      wakeLock.released = true;
      releaseListener?.();
    })
  };
  return wakeLock;
}

describe("TimerEffects", () => {
  it("unlocks audio, plays one completion chime, and closes after playback", async () => {
    const audio = audioFixture();
    const effects = new TimerEffects({
      createAudioContext: () => audio.context,
      requestWakeLock: null
    });

    await effects.unlockAudio();
    audio.context.state = "running";
    await effects.playCompletionSound();

    expect(audio.context.resume).toHaveBeenCalledOnce();
    expect(audio.oscillator.start).toHaveBeenCalledWith(10);
    expect(audio.oscillator.stop).toHaveBeenCalledWith(10.6);
    audio.finish();
    expect(audio.context.close).toHaveBeenCalledOnce();
  });

  it("holds the wake lock only until the timer stops", async () => {
    const wakeLock = wakeLockFixture();
    const requestWakeLock = vi.fn(async () => wakeLock);
    const effects = new TimerEffects({
      createAudioContext: null,
      requestWakeLock
    });

    await effects.keepScreenAwake();
    await effects.releaseWakeLock();

    expect(requestWakeLock).toHaveBeenCalledOnce();
    expect(wakeLock.release).toHaveBeenCalledOnce();
  });

  it("releases a wake lock that arrives after the timer stops", async () => {
    const wakeLock = wakeLockFixture();
    let resolveWakeLock!: (value: TimerWakeLock) => void;
    const pendingWakeLock = new Promise<TimerWakeLock>((resolve) => {
      resolveWakeLock = resolve;
    });
    const effects = new TimerEffects({
      createAudioContext: null,
      requestWakeLock: () => pendingWakeLock
    });

    const request = effects.keepScreenAwake();
    const release = effects.releaseWakeLock();
    resolveWakeLock(wakeLock);
    await Promise.all([request, release]);

    expect(wakeLock.release).toHaveBeenCalledOnce();
  });

  it("keeps the timer usable when browser effects are unsupported", async () => {
    const effects = new TimerEffects({
      createAudioContext: null,
      requestWakeLock: null
    });

    await expect(effects.unlockAudio()).resolves.toBeUndefined();
    await expect(effects.playCompletionSound()).resolves.toBeUndefined();
    await expect(effects.keepScreenAwake()).resolves.toBeUndefined();
    await expect(effects.stop()).resolves.toBeUndefined();
  });
});
