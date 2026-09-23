export interface AllowanceRule {
  id: number;
  baseAmountYen: number;
  bonusIntervalDays: number;
  bonusAmountYen: number;
  effectiveFrom: string;
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
}

export interface CalendarData {
  month: string;
  currentStreakDays: number;
  weeklyAchievementCount: number;
  weeklyEarnedYen: number;
  unpaidBalanceYen: number;
  achievements: Achievement[];
}

export interface ParentDashboard {
  unpaidBalanceYen: number;
  unpaidAchievementCount: number;
  currentStreakDays: number;
  oldestUnpaidDate: string | null;
  newestUnpaidDate: string | null;
  currentAllowanceRule: AllowanceRule;
}

export interface Payment {
  id: string;
  amountYen: number;
  periodStartDate: string;
  periodEndDate: string;
  paidAt: string;
  achievementCount: number;
}
