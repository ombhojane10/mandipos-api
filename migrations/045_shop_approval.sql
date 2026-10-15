-- A new shop waits for MandiPlus to approve it before its owner's phone opens it. Until then
-- the owner is a member but no device is attached, so nothing can sync or be seen; approving
-- lets the next /v1/me attach the device. Every shop that already exists is approved.
ALTER TABLE shops
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN approved_by text NOT NULL DEFAULT '',
  ADD COLUMN rejected_at timestamptz,
  ADD COLUMN reject_reason text NOT NULL DEFAULT '';

UPDATE shops SET approved_at = created_at, approved_by = 'existing';

CREATE INDEX shops_pending ON shops (created_at) WHERE approved_at IS NULL AND rejected_at IS NULL;
