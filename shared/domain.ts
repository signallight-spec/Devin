export type AchievementMethod = "timer" | "self_report";

export function addLocalDays(localDate: string, amount: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + amount));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0")
  ].join("-");
}

export function localDateInTokyo(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function mondayWeekRange(localDate: string): {
  start: string;
  end: string;
} {
  const [year, month, day] = localDate.split("-").map(Number);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const daysFromMonday = (weekday + 6) % 7;
  const start = addLocalDays(localDate, -daysFromMonday);
  return { start, end: addLocalDays(start, 6) };
}

export function calculateStreak(
  previousLocalDate: string | null,
  previousStreakDays: number | null,
  today: string
): number {
  if (
    previousLocalDate === addLocalDays(today, -1) &&
    previousStreakDays !== null
  ) {
    return previousStreakDays + 1;
  }
  return 1;
}

export function displayedStreak(
  latestLocalDate: string | null,
  latestStreakDays: number | null,
  today: string
): number {
  if (
    latestLocalDate === today ||
    latestLocalDate === addLocalDays(today, -1)
  ) {
    return latestStreakDays ?? 0;
  }
  return 0;
}

export function calculateReward(
  streakDays: number,
  baseAmountYen: number,
  bonusIntervalDays: number,
  bonusAmountYen: number
): { baseAmountYen: number; bonusAmountYen: number; totalAmountYen: number } {
  const bonus = streakDays % bonusIntervalDays === 0 ? bonusAmountYen : 0;
  return {
    baseAmountYen,
    bonusAmountYen: bonus,
    totalAmountYen: baseAmountYen + bonus
  };
}
