export interface AllowanceRule {
  id: number;
  baseAmountYen: number;
  bonusIntervalDays: number;
  bonusAmountYen: number;
  effectiveFrom: string;
}

export type CharacterSpecies = "dragon" | "fox" | "owl" | "rabbit" | "bear";
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

export interface Achievement {
  id: string;
  localDate: string;
  method: "timer" | "self_report";
  subject: string | null;
  note: string | null;
  targetMinutes: number;
  streakDays: number;
  baseAmountYen: number;
  bonusAmountYen: number;
  totalAmountYen: number;
  achievedAt: string;
  paid: boolean;
}

export interface Today {
  localDate: string;
  goalMinutes: number;
  currentStreakDays: number;
  achievement: Achievement | null;
  allowanceRule: AllowanceRule;
  character: CharacterState;
  notification: {
    enabled: boolean;
    time: string;
    available: boolean;
    publicKey: string | null;
  };
}

export interface CalendarData {
  month: string;
  currentStreakDays: number;
  weeklyAchievementCount: number;
  weeklyEarnedYen: number;
  unpaidBalanceYen: number;
  achievements: Achievement[];
  character: CharacterState;
}

export interface ParentDashboard {
  unpaidBalanceYen: number;
  unpaidAchievementCount: number;
  currentStreakDays: number;
  oldestUnpaidDate: string | null;
  newestUnpaidDate: string | null;
  currentAllowanceRule: AllowanceRule;
  notificationSettings: {
    enabled: boolean;
    time: string;
  };
}

export interface Payment {
  id: string;
  amountYen: number;
  periodStartDate: string;
  periodEndDate: string;
  paidAt: string;
  achievementCount: number;
}

export interface Settlement extends Payment {
  replayed: boolean;
}
