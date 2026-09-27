import { localDateInTokyo } from "../shared/domain";

export interface PersistedTimer {
  endsAt: number;
  localDate: string;
  goalMinutes: number;
}

export function parsePersistedTimer(
  value: string | null,
  now: Date
): PersistedTimer | null {
  if (!value) {
    return null;
  }
  try {
    const candidate = JSON.parse(value) as Partial<PersistedTimer>;
    if (
      typeof candidate.endsAt !== "number" ||
      !Number.isFinite(candidate.endsAt) ||
      !Number.isInteger(candidate.goalMinutes) ||
      candidate.goalMinutes === undefined ||
      candidate.goalMinutes < 1 ||
      candidate.goalMinutes > 180 ||
      candidate.localDate !== localDateInTokyo(now)
    ) {
      return null;
    }
    return {
      endsAt: candidate.endsAt,
      localDate: candidate.localDate,
      goalMinutes: candidate.goalMinutes
    };
  } catch {
    return null;
  }
}

export function serializePersistedTimer(timer: PersistedTimer): string {
  return JSON.stringify(timer);
}
