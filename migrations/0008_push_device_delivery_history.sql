ALTER TABLE push_subscriptions
ADD COLUMN device_id TEXT;

UPDATE push_subscriptions
SET device_id = endpoint
WHERE device_id IS NULL;

CREATE UNIQUE INDEX idx_push_subscriptions_device
  ON push_subscriptions(device_id);

CREATE TABLE notification_delivery_devices (
  local_date TEXT NOT NULL,
  device_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  sent_at_utc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent'
    CHECK (status IN ('pending', 'sent', 'failed')),
  claim_token TEXT,
  PRIMARY KEY (local_date, device_id)
);

INSERT INTO notification_delivery_devices (
  local_date, device_id, endpoint, sent_at_utc, status, claim_token
)
SELECT
  delivery.local_date,
  subscription.device_id,
  delivery.endpoint,
  delivery.sent_at_utc,
  delivery.status,
  delivery.claim_token
FROM notification_delivery_subscriptions delivery
JOIN push_subscriptions subscription
  ON subscription.endpoint = delivery.endpoint;

DROP TABLE notification_delivery_subscriptions;
ALTER TABLE notification_delivery_devices
RENAME TO notification_delivery_subscriptions;
