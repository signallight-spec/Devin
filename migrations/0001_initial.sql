PRAGMA foreign_keys = ON;

CREATE TABLE app_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo'
    CHECK (timezone = 'Asia/Tokyo'),
  goal_minutes INTEGER NOT NULL DEFAULT 25
    CHECK (
      goal_minutes BETWEEN 5 AND 180
      AND goal_minutes % 5 = 0
    ),
  family_key_hash TEXT NOT NULL
    CHECK (length(family_key_hash) = 64),
  pin_hash TEXT NOT NULL,
  pin_failed_attempts INTEGER NOT NULL DEFAULT 0
    CHECK (pin_failed_attempts >= 0),
  pin_locked_until_utc TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL
);

CREATE TABLE allowance_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_amount_yen INTEGER NOT NULL
    CHECK (base_amount_yen BETWEEN 0 AND 100000),
  bonus_interval_days INTEGER NOT NULL DEFAULT 7
    CHECK (bonus_interval_days BETWEEN 1 AND 365),
  bonus_amount_yen INTEGER NOT NULL
    CHECK (bonus_amount_yen BETWEEN 0 AND 100000),
  effective_from_utc TEXT NOT NULL UNIQUE,
  created_at_utc TEXT NOT NULL
);

CREATE TABLE achievements (
  id TEXT PRIMARY KEY,
  local_date TEXT NOT NULL UNIQUE
    CHECK (
      length(local_date) = 10
      AND substr(local_date, 5, 1) = '-'
      AND substr(local_date, 8, 1) = '-'
    ),
  method TEXT NOT NULL
    CHECK (method IN ('timer', 'self_report')),
  subject TEXT
    CHECK (subject IS NULL OR length(subject) BETWEEN 1 AND 20),
  note TEXT
    CHECK (note IS NULL OR length(note) BETWEEN 1 AND 120),
  target_minutes INTEGER NOT NULL
    CHECK (
      target_minutes BETWEEN 5 AND 180
      AND target_minutes % 5 = 0
    ),
  streak_days INTEGER NOT NULL
    CHECK (streak_days >= 1),
  base_amount_yen INTEGER NOT NULL
    CHECK (base_amount_yen >= 0),
  bonus_amount_yen INTEGER NOT NULL
    CHECK (bonus_amount_yen >= 0),
  total_amount_yen INTEGER NOT NULL
    CHECK (
      total_amount_yen >= 0
      AND total_amount_yen = base_amount_yen + bonus_amount_yen
    ),
  allowance_rule_id INTEGER NOT NULL,
  achieved_at_utc TEXT NOT NULL,
  FOREIGN KEY (allowance_rule_id)
    REFERENCES allowance_rules(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE TABLE payments (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  amount_yen INTEGER NOT NULL DEFAULT 0
    CHECK (amount_yen >= 0),
  period_start_date TEXT,
  period_end_date TEXT,
  paid_at_utc TEXT NOT NULL
);

CREATE TABLE payment_achievements (
  payment_id TEXT NOT NULL,
  achievement_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (payment_id, achievement_id),
  FOREIGN KEY (payment_id)
    REFERENCES payments(id)
    ON UPDATE RESTRICT
    ON DELETE CASCADE,
  FOREIGN KEY (achievement_id)
    REFERENCES achievements(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

CREATE INDEX achievements_achieved_at_idx
  ON achievements(achieved_at_utc DESC);

CREATE INDEX allowance_rules_effective_idx
  ON allowance_rules(effective_from_utc DESC);

CREATE INDEX payment_achievements_payment_idx
  ON payment_achievements(payment_id);

CREATE VIEW unpaid_achievements AS
SELECT a.*
FROM achievements AS a
LEFT JOIN payment_achievements AS pa
  ON pa.achievement_id = a.id
WHERE pa.achievement_id IS NULL;
