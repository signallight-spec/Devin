export interface TimerAudioParam {
  setValueAtTime(value: number, startTime: number): void;
  exponentialRampToValueAtTime(value: number, endTime: number): void;
}

export interface TimerAudioNode {
  connect(destination: TimerAudioNode): TimerAudioNode;
}

export interface TimerOscillator extends TimerAudioNode {
  frequency: TimerAudioParam;
  type: OscillatorType;
  addEventListener(
    type: "ended",
    listener: () => void,
    options: { once: boolean }
  ): void;
  start(when?: number): void;
  stop(when?: number): void;
}

export interface TimerGain extends TimerAudioNode {
  gain: TimerAudioParam;
}

export interface TimerAudioContext {
  currentTime: number;
  destination: TimerAudioNode;
  state: AudioContextState;
  close(): Promise<void>;
  createGain(): TimerGain;
  createOscillator(): TimerOscillator;
  resume(): Promise<void>;
}

export interface TimerWakeLock {
  released: boolean;
  addEventListener(
    type: "release",
    listener: () => void,
    options: { once: boolean }
  ): void;
  release(): Promise<void>;
}

export interface TimerEffectsEnvironment {
  createAudioContext: (() => TimerAudioContext) | null;
  requestWakeLock: (() => Promise<TimerWakeLock>) | null;
}

export class TimerEffects {
  private audioContext: TimerAudioContext | null = null;
  private wakeLock: TimerWakeLock | null = null;
  private wakeLockRequest: Promise<void> | null = null;
  private wakeLockWanted = false;

  constructor(private readonly environment: TimerEffectsEnvironment) {}

  async unlockAudio(): Promise<void> {
    if (!this.environment.createAudioContext) {
      return;
    }
    try {
      this.audioContext ??= this.environment.createAudioContext();
      if (this.audioContext.state === "suspended") {
        await this.audioContext.resume();
      }
    } catch {
      await this.closeAudio();
    }
  }

  async playCompletionSound(): Promise<void> {
    const context = this.audioContext;
    if (!context) {
      return;
    }
    try {
      if (context.state === "suspended") {
        await context.resume();
      }
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const startsAt = context.currentTime;

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(660, startsAt);
      oscillator.frequency.setValueAtTime(880, startsAt + 0.18);
      gain.gain.setValueAtTime(0.0001, startsAt);
      gain.gain.exponentialRampToValueAtTime(0.24, startsAt + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + 0.55);
      oscillator.connect(gain).connect(context.destination);
      oscillator.addEventListener("ended", () => {
        void this.closeAudio();
      }, { once: true });
      oscillator.start(startsAt);
      oscillator.stop(startsAt + 0.6);
    } catch {
      await this.closeAudio();
    }
  }

  keepScreenAwake(): Promise<void> {
    this.wakeLockWanted = true;
    if (
      this.wakeLock ||
      this.wakeLockRequest ||
      !this.environment.requestWakeLock
    ) {
      return this.wakeLockRequest ?? Promise.resolve();
    }

    const request = this.environment.requestWakeLock;
    this.wakeLockRequest = request()
      .then(async (wakeLock) => {
        if (!this.wakeLockWanted) {
          await wakeLock.release();
          return;
        }
        this.wakeLock = wakeLock;
        wakeLock.addEventListener("release", () => {
          if (this.wakeLock === wakeLock) {
            this.wakeLock = null;
          }
        }, { once: true });
      })
      .catch(() => undefined)
      .finally(() => {
        this.wakeLockRequest = null;
      });
    return this.wakeLockRequest;
  }

  async releaseWakeLock(): Promise<void> {
    this.wakeLockWanted = false;
    await this.wakeLockRequest;
    const wakeLock = this.wakeLock;
    this.wakeLock = null;
    if (wakeLock && !wakeLock.released) {
      await wakeLock.release().catch(() => undefined);
    }
  }

  async stop(): Promise<void> {
    await Promise.all([this.releaseWakeLock(), this.closeAudio()]);
  }

  private async closeAudio(): Promise<void> {
    const context = this.audioContext;
    this.audioContext = null;
    if (context && context.state !== "closed") {
      await context.close().catch(() => undefined);
    }
  }
}

export function createBrowserTimerEffects(): TimerEffects {
  return new TimerEffects({
    createAudioContext:
      typeof window.AudioContext === "undefined"
        ? null
        : () => new window.AudioContext(),
    requestWakeLock:
      typeof navigator.wakeLock === "undefined"
        ? null
        : () => navigator.wakeLock.request("screen")
  });
}
