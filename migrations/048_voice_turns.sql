-- The voice assistant ("Bolo"): every turn the model answered, kept so its mistakes can be
-- read back and turned into test cases. The audio itself is never stored, only what was heard
-- and what the model made of it; [outcome] is what the counter then did with the draft
-- (saved it as is, changed it first, or threw it away), which is the accuracy number.
CREATE TABLE voice_turns (
  id          uuid PRIMARY KEY,
  shop_id     uuid NOT NULL REFERENCES shops(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  device_id   uuid NOT NULL REFERENCES devices(id),
  screen      text NOT NULL DEFAULT '',
  transcript  text NOT NULL DEFAULT '',
  kind        text NOT NULL DEFAULT '',
  reply       jsonb NOT NULL DEFAULT '{}',
  model       text NOT NULL DEFAULT '',
  audio_ms    integer NOT NULL DEFAULT 0,
  latency_ms  integer NOT NULL DEFAULT 0,
  tokens_in   integer NOT NULL DEFAULT 0,
  tokens_out  integer NOT NULL DEFAULT 0,
  error       text,
  outcome     text CHECK (outcome IN ('saved', 'edited', 'discarded', 'opened')),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voice_turns_shop_at ON voice_turns (shop_id, created_at DESC);

ALTER TABLE voice_turns ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON voice_turns TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON voice_turns TO mandipos_api;
