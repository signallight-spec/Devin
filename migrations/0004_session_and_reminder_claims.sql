PRAGMA foreign_keys = ON;

ALTER TABLE app_settings
ADD COLUMN parent_session_version INTEGER NOT NULL DEFAULT 1
  CHECK (parent_session_version >= 1);

ALTER TABLE notification_delivery_subscriptions
ADD COLUMN status TEXT NOT NULL DEFAULT 'sent'
  CHECK (status IN ('pending', 'sent', 'failed'));
