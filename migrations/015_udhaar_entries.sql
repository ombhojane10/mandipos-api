-- Udhaar that did not come from a slip in this app.
--
-- A grahak arrives with a balance from the old book ("purana udhaar"), or the shop adds
-- credit by hand. Each is an insert-once fact against the buyer; the balance is slips'
-- baaki + these − vasooli, so it continues from wherever the book left off.

CREATE TABLE udhaar_entries (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  buyer_id       uuid NOT NULL,
  amount_paise   bigint NOT NULL CHECK (amount_paise > 0),
  note           text NOT NULL DEFAULT '',
  business_date  date NOT NULL,
  device_id      uuid NOT NULL REFERENCES devices(id),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, buyer_id) REFERENCES buyers (shop_id, id),
  UNIQUE (shop_id, id)
);

CREATE INDEX udhaar_entries_buyer ON udhaar_entries (shop_id, buyer_id);

GRANT SELECT, INSERT ON udhaar_entries TO mandipos_api;

ALTER TABLE udhaar_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON udhaar_entries TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);
