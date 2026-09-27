import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createBrowserTimerEffects } from "../timerEffects";

const TIMER_END_STORAGE = "study-habit-timer-ends-at";

export interface StudyTimer {
  active: boolean;
  completed: boolean;
  remainingSeconds: number;
  start: () => void;
  reset: () => void;
}

export function useTimer(goalMinutes: number): StudyTimer {
  const [effects] = useState(createBrowserTimerEffects);
  const [endsAt, setEndsAt] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(TIMER_END_STORAGE));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });
  const [now, setNow] = useState(Date.now());
  const completionSoundEndsAt = useRef<number | null>(
    endsAt !== null && endsAt <= Date.now() ? endsAt : null
  );

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

  const start = useCallback(() => {
    void effects.unlockAudio();
    const nextEndsAt = Date.now() + goalMinutes * 60 * 1000;
    localStorage.setItem(TIMER_END_STORAGE, String(nextEndsAt));
    setNow(Date.now());
    setEndsAt(nextEndsAt);
  }, [effects, goalMinutes]);

  const reset = useCallback(() => {
    void effects.stop();
    localStorage.removeItem(TIMER_END_STORAGE);
    setEndsAt(null);
    setNow(Date.now());
  }, [effects]);

  return {
    active,
    completed,
    remainingSeconds,
    start,
    reset
  };
}
