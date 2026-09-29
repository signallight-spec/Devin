PRAGMA defer_foreign_keys = ON;

DROP VIEW unpaid_achievements;

CREATE TABLE achievements_with_rule_fk (
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

INSERT INTO achievements_with_rule_fk
SELECT * FROM achievements;

CREATE TABLE payment_achievements_with_rule_fk (
  payment_id TEXT NOT NULL,
  achievement_id TEXT NOT NULL UNIQUE,
  PRIMARY KEY (payment_id, achievement_id),
  FOREIGN KEY (payment_id)
    REFERENCES payments(id)
    ON UPDATE RESTRICT
    ON DELETE CASCADE,
  FOREIGN KEY (achievement_id)
    REFERENCES achievements_with_rule_fk(id)
    ON UPDATE RESTRICT
    ON DELETE RESTRICT
);

INSERT INTO payment_achievements_with_rule_fk
SELECT * FROM payment_achievements;

DROP TABLE payment_achievements;
DROP TABLE achievements;
ALTER TABLE achievements_with_rule_fk RENAME TO achievements;
ALTER TABLE payment_achievements_with_rule_fk
  RENAME TO payment_achievements;

CREATE INDEX achievements_achieved_at_idx
  ON achievements(achieved_at_utc DESC);

CREATE INDEX payment_achievements_payment_idx
  ON payment_achievements(payment_id);

CREATE VIEW unpaid_achievements AS
SELECT a.*
FROM achievements AS a
LEFT JOIN payment_achievements AS pa
  ON pa.achievement_id = a.id
WHERE pa.achievement_id IS NULL;
