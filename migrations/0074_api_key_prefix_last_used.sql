-- API key display prefix and last use (#353). Additive after 0073; no backfill.
-- display_prefix is the scheme plus the first 8 of the 43 secret characters, recorded at creation: 48 of the 256 random
-- bits, leaving 208 undisclosed. Keys created earlier keep NULL because their plaintext is not recoverable.
-- last_used_at is set after a successful API-key authentication, at most once per minute per key.
ALTER TABLE api_key ADD COLUMN display_prefix text CHECK (display_prefix ~ '^t98k_[A-Za-z0-9_-]{8}$');
ALTER TABLE api_key ADD COLUMN last_used_at timestamptz;
