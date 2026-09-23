export type AchievementMethod = "timer" | "self_report";
export const CHARACTER_SPECIES = [
  "dragon",
  "fox",
  "owl",
  "rabbit",
  "bear"
] as const;

export type CharacterSpecies = (typeof CHARACTER_SPECIES)[number];
export type CharacterStage = "egg" | "cracked" | "hatchling" | "juvenile" | "adult";
export type StreakDecoration = "none" | "stars" | "crown" | "aura";

export interface CharacterState {
  species: CharacterSpecies;
  stage: CharacterStage;
  totalAchievementDays: number;
  cycleProgressDays: number;
  cycleGoalDays: number;
  nextStageAt: number | null;
  streakDecoration: StreakDecoration;
  collection: Array<{
    species: CharacterSpecies;
    grownCount: number;
  }>;
}

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

export function localTimeInTokyo(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
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

function shuffledSpecies(seed: number, round: number): CharacterSpecies[] {
  const result = [...CHARACTER_SPECIES];
  let state = (seed ^ Math.imul(round + 1, 0x9e3779b9)) >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const swapIndex = state % (index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function characterSpeciesForCycle(
  seed: number,
  cycleIndex: number
): CharacterSpecies {
  const round = Math.floor(cycleIndex / CHARACTER_SPECIES.length);
  const order = shuffledSpecies(seed, round);
  return order[cycleIndex % CHARACTER_SPECIES.length];
}

export function calculateCharacterState(
  totalAchievementDays: number,
  currentStreakDays: number,
  seed: number
): CharacterState {
  const completedCycles = Math.floor(totalAchievementDays / 30);
  const completedToday =
    totalAchievementDays > 0 && totalAchievementDays % 30 === 0;
  const cycleIndex = completedToday ? completedCycles - 1 : completedCycles;
  const cycleProgressDays = completedToday ? 30 : totalAchievementDays % 30;
  const stage: CharacterStage =
    cycleProgressDays >= 30
      ? "adult"
      : cycleProgressDays >= 14
        ? "juvenile"
        : cycleProgressDays >= 7
          ? "hatchling"
          : cycleProgressDays >= 3
            ? "cracked"
            : "egg";
  const nextStageAt =
    cycleProgressDays < 3
      ? 3
      : cycleProgressDays < 7
        ? 7
        : cycleProgressDays < 14
          ? 14
          : cycleProgressDays < 30
            ? 30
            : null;
  const streakDecoration: StreakDecoration =
    currentStreakDays >= 14
      ? "aura"
      : currentStreakDays >= 7
        ? "crown"
        : currentStreakDays >= 3
          ? "stars"
          : "none";
  const counts = new Map<CharacterSpecies, number>(
    CHARACTER_SPECIES.map((species) => [species, 0])
  );
  for (let index = 0; index < completedCycles; index += 1) {
    const species = characterSpeciesForCycle(seed, index);
    counts.set(species, (counts.get(species) ?? 0) + 1);
  }

  return {
    species: characterSpeciesForCycle(seed, Math.max(0, cycleIndex)),
    stage,
    totalAchievementDays,
    cycleProgressDays,
    cycleGoalDays: 30,
    nextStageAt,
    streakDecoration,
    collection: CHARACTER_SPECIES.map((species) => ({
      species,
      grownCount: counts.get(species) ?? 0
    }))
  };
}
