PRAGMA foreign_keys = ON;

ALTER TABLE app_settings
ADD COLUMN pending_family_key_hash TEXT
  CHECK (pending_family_key_hash IS NULL OR length(pending_family_key_hash) = 64);

ALTER TABLE app_settings
ADD COLUMN pending_family_key_created_at_utc TEXT;

CREATE TABLE notification_delivery_subscriptions (
  local_date TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  sent_at_utc TEXT NOT NULL,
  PRIMARY KEY (local_date, endpoint),
  FOREIGN KEY (endpoint)
    REFERENCES push_subscriptions(endpoint)
    ON UPDATE RESTRICT
    ON DELETE CASCADE
);
