import type {
  AchievementRow,
  AllowanceRuleRow,
  AppSettingsRow,
  PaymentRow
} from "./types";

export async function getSettings(db: D1Database): Promise<AppSettingsRow | null> {
  return db.prepare("SELECT * FROM app_settings WHERE id = 1").first<AppSettingsRow>();
}

export async function getCurrentRule(
  db: D1Database,
  nowIso: string
): Promise<AllowanceRuleRow | null> {
  return db
    .prepare(
      `SELECT * FROM allowance_rules
       WHERE effective_from_utc <= ?
       ORDER BY effective_from_utc DESC
       LIMIT 1`
    )
    .bind(nowIso)
    .first<AllowanceRuleRow>();
}

export function mapRule(row: AllowanceRuleRow) {
  return {
    id: row.id,
    baseAmountYen: row.base_amount_yen,
    bonusIntervalDays: row.bonus_interval_days,
    bonusAmountYen: row.bonus_amount_yen,
    effectiveFrom: row.effective_from_utc
  };
}

export function mapAchievement(row: AchievementRow) {
  return {
    id: row.id,
    localDate: row.local_date,
    method: row.method,
    subject: row.subject,
    note: row.note,
    targetMinutes: row.target_minutes,
    streakDays: row.streak_days,
    baseAmountYen: row.base_amount_yen,
    bonusAmountYen: row.bonus_amount_yen,
    totalAmountYen: row.total_amount_yen,
    achievedAt: row.achieved_at_utc,
    paid: Boolean(row.paid)
  };
}

export function mapPayment(row: PaymentRow) {
  return {
    id: row.id,
    amountYen: row.amount_yen,
    periodStartDate: row.period_start_date,
    periodEndDate: row.period_end_date,
    paidAt: row.paid_at_utc,
    achievementCount: row.achievement_count
  };
}

export const ACHIEVEMENT_WITH_PAID = `
  SELECT a.*,
    CASE WHEN pa.achievement_id IS NULL THEN 0 ELSE 1 END AS paid
  FROM achievements a
  LEFT JOIN payment_achievements pa ON pa.achievement_id = a.id
`;

export const PAYMENT_WITH_COUNT = `
  SELECT p.*, COUNT(pa.achievement_id) AS achievement_count
  FROM payments p
  JOIN payment_achievements pa ON pa.payment_id = p.id
`;
