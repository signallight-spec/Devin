import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { localDateInTokyo } from "../../shared/domain";
import { createBrowserTimerEffects } from "../timerEffects";
import {
  parsePersistedTimer,
  serializePersistedTimer,
  type PersistedTimer
} from "../timerState";

const TIMER_END_STORAGE = "study-habit-timer-ends-at";

export interface StudyTimer {
  active: boolean;
  completed: boolean;
  remainingSeconds: number;
  targetMinutes: number | null;
  start: () => void;
  reset: () => void;
}

export function useTimer(goalMinutes: number): StudyTimer {
  const [effects] = useState(createBrowserTimerEffects);
  const [timerState, setTimerState] = useState<PersistedTimer | null>(() =>
    parsePersistedTimer(localStorage.getItem(TIMER_END_STORAGE), new Date())
  );
  const [now, setNow] = useState(Date.now());
  const completionSoundEndsAt = useRef<number | null>(
    timerState !== null && timerState.endsAt <= Date.now()
      ? timerState.endsAt
      : null
  );
  const eligibleTimer =
    timerState?.localDate === localDateInTokyo(new Date(now))
      ? timerState
      : null;
  const endsAt = eligibleTimer?.endsAt ?? null;

  useEffect(() => {
    if (!endsAt) {
      return;
    }
    const tick = () => setNow(Date.now());
    tick();
    const interval = window.setInterval(tick, 500);
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [endsAt]);

  const remainingSeconds = useMemo(
    () => (endsAt ? Math.max(0, Math.ceil((endsAt - now) / 1000)) : goalMinutes * 60),
    [endsAt, goalMinutes, now]
  );
  const completed = endsAt !== null && remainingSeconds === 0;
  const active = endsAt !== null && !completed;
  const targetMinutes = eligibleTimer?.goalMinutes ?? null;

  useEffect(() => {
    if (!active) {
      void effects.releaseWakeLock();
      return;
    }
    void effects.keepScreenAwake();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void effects.keepScreenAwake();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      void effects.releaseWakeLock();
    };
  }, [active, effects]);

  useEffect(() => {
    if (!completed || endsAt === null || completionSoundEndsAt.current === endsAt) {
      return;
    }
    completionSoundEndsAt.current = endsAt;
    void effects.playCompletionSound();
  }, [completed, effects, endsAt]);

  useEffect(() => () => {
    void effects.stop();
  }, [effects]);

  useEffect(() => {
    if (timerState && !eligibleTimer) {
      void effects.stop();
      localStorage.removeItem(TIMER_END_STORAGE);
      setTimerState(null);
    }
  }, [effects, eligibleTimer, timerState]);

  const start = useCallback(() => {
    void effects.unlockAudio();
    const startedAt = new Date();
    const nextTimerState = {
      endsAt: startedAt.getTime() + goalMinutes * 60 * 1000,
      localDate: localDateInTokyo(startedAt),
      goalMinutes
    };
    localStorage.setItem(
      TIMER_END_STORAGE,
      serializePersistedTimer(nextTimerState)
    );
    setNow(startedAt.getTime());
    setTimerState(nextTimerState);
  }, [effects, goalMinutes]);

  const reset = useCallback(() => {
    void effects.stop();
    localStorage.removeItem(TIMER_END_STORAGE);
    setTimerState(null);
    setNow(Date.now());
  }, [effects]);

  return {
    active,
    completed,
    remainingSeconds,
    targetMinutes,
    start,
    reset
  };
}
