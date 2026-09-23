export interface Env {
  DB: D1Database;
  BOOTSTRAP_TOKEN: string;
  PARENT_SESSION_SECRET: string;
}

export interface AppSettingsRow {
  id: number;
  timezone: string;
  goal_minutes: number;
  family_key_hash: string;
  pin_hash: string;
  pin_failed_attempts: number;
  pin_locked_until_utc: string | null;
  created_at_utc: string;
  updated_at_utc: string;
}

export interface AllowanceRuleRow {
  id: number;
  base_amount_yen: number;
  bonus_interval_days: number;
  bonus_amount_yen: number;
  effective_from_utc: string;
  created_at_utc: string;
}

export interface AchievementRow {
  id: string;
  local_date: string;
  method: "timer" | "self_report";
  subject: string | null;
  note: string | null;
  target_minutes: number;
  streak_days: number;
  base_amount_yen: number;
  bonus_amount_yen: number;
  total_amount_yen: number;
  allowance_rule_id: number;
  achieved_at_utc: string;
  paid: number;
}

export interface PaymentRow {
  id: string;
  idempotency_key: string;
  amount_yen: number;
  period_start_date: string;
  period_end_date: string;
  paid_at_utc: string;
  achievement_count: number;
}
