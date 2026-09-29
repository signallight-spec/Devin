PRAGMA defer_foreign_keys = ON;

CREATE TABLE allowance_rules_ordered (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  base_amount_yen INTEGER NOT NULL
    CHECK (base_amount_yen BETWEEN 0 AND 100000),
  bonus_interval_days INTEGER NOT NULL DEFAULT 7
    CHECK (bonus_interval_days BETWEEN 1 AND 365),
  bonus_amount_yen INTEGER NOT NULL
    CHECK (bonus_amount_yen BETWEEN 0 AND 100000),
  effective_from_utc TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

INSERT INTO allowance_rules_ordered (
  id, base_amount_yen, bonus_interval_days, bonus_amount_yen,
  effective_from_utc, created_at_utc
)
SELECT
  id, base_amount_yen, bonus_interval_days, bonus_amount_yen,
  effective_from_utc, created_at_utc
FROM allowance_rules;

DROP TABLE allowance_rules;
ALTER TABLE allowance_rules_ordered RENAME TO allowance_rules;

CREATE INDEX idx_allowance_rules_effective
  ON allowance_rules(effective_from_utc DESC, id DESC);
