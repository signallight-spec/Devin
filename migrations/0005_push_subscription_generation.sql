ALTER TABLE push_subscriptions
ADD COLUMN family_key_generation TEXT NOT NULL DEFAULT 'active'
  CHECK (family_key_generation IN ('active', 'pending'));
