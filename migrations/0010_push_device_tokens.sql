ALTER TABLE push_subscriptions
ADD COLUMN device_token_hash TEXT
  CHECK (device_token_hash IS NULL OR length(device_token_hash) = 64);
