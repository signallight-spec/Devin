import { useCallback, useEffect, useMemo, useState } from "react";

const TIMER_END_STORAGE = "study-habit-timer-ends-at";

export function useTimer(goalMinutes: number) {
  const [endsAt, setEndsAt] = useState<number | null>(() => {
    const stored = Number(localStorage.getItem(TIMER_END_STORAGE));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  });
  const [now, setNow] = useState(Date.now());

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

  useEffect(() => {
    if (completed) {
      localStorage.removeItem(TIMER_END_STORAGE);
    }
  }, [completed]);

  const start = useCallback(() => {
    const nextEndsAt = Date.now() + goalMinutes * 60 * 1000;
    localStorage.setItem(TIMER_END_STORAGE, String(nextEndsAt));
    setNow(Date.now());
    setEndsAt(nextEndsAt);
  }, [goalMinutes]);

  const reset = useCallback(() => {
    localStorage.removeItem(TIMER_END_STORAGE);
    setEndsAt(null);
    setNow(Date.now());
  }, []);

  return {
    active: endsAt !== null && !completed,
    completed,
    remainingSeconds,
    start,
    reset
  };
}
