ALTER TABLE app_settings
ADD COLUMN character_seed INTEGER NOT NULL DEFAULT 0
  CHECK (character_seed BETWEEN 0 AND 2147483647);

ALTER TABLE app_settings
ADD COLUMN notifications_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (notifications_enabled IN (0, 1));

ALTER TABLE app_settings
ADD COLUMN notification_time TEXT NOT NULL DEFAULT '20:00'
  CHECK (
    length(notification_time) = 5
    AND substr(notification_time, 3, 1) = ':'
  );

UPDATE app_settings
SET character_seed = abs(random() % 2147483646) + 1
WHERE character_seed = 0;

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  last_success_at_utc TEXT
);

CREATE TABLE notification_deliveries (
  local_date TEXT PRIMARY KEY,
  claimed_at_utc TEXT NOT NULL,
  sent_count INTEGER NOT NULL DEFAULT 0
    CHECK (sent_count >= 0)
);
