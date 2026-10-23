-- Angoor, second pass after the founder's review.
--
-- * shops.apmc_on: APMC is charged on every slip by default, but a shop switches it off for
--   sales the market fee doesn't apply to. Off means new slips carry apmc_paise = 0.
-- * shops.slip_whatsapp: send each slip to the grahak on WhatsApp as it is saved. Off until the
--   shop turns it on.
-- * spoilage kind 'sample': boxes opened for the sample pieces on display ("5 pieces of each
--   quality"). They leave the stock like store/broken, and never count as a sale.
-- * supplier_phones: the WhatsApp number a party's beejak goes to, kept per supplier name
--   (suppliers are free text on trucks, so the name is the key).
-- * whatsapp_slip_sends: every slip or beejak sent on WhatsApp, logged before it goes; a second
--   send of the same thing to the same number within 10 minutes is refused.

ALTER TABLE shops ADD COLUMN apmc_on boolean NOT NULL DEFAULT true;
ALTER TABLE shops ADD COLUMN slip_whatsapp boolean NOT NULL DEFAULT false;

ALTER TABLE spoilage DROP CONSTRAINT spoilage_kind_check;
ALTER TABLE spoilage ADD CONSTRAINT spoilage_kind_check CHECK (kind IN ('spoiled', 'correction', 'store', 'broken', 'sample'));

CREATE TABLE supplier_phones (
  id           uuid PRIMARY KEY,
  shop_id      uuid NOT NULL REFERENCES shops(id),
  name         text NOT NULL CHECK (btrim(name) <> ''),
  phone        text NOT NULL CHECK (phone = '' OR phone ~ '^[6-9][0-9]{9}$'),
  device_id    uuid NOT NULL REFERENCES devices(id),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

GRANT SELECT, INSERT, UPDATE ON supplier_phones TO mandipos_api;
ALTER TABLE supplier_phones ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON supplier_phones TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

CREATE TABLE whatsapp_slip_sends (
  id            uuid PRIMARY KEY,
  shop_id       uuid NOT NULL REFERENCES shops(id),
  kind          text NOT NULL CHECK (kind IN ('slip', 'beejak')),
  ref_id        uuid NOT NULL,
  phone         text NOT NULL,
  sent_by       uuid NOT NULL REFERENCES users(id),
  status        text NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  wa_message_id text,
  error         text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_slip_sends_ref ON whatsapp_slip_sends (shop_id, kind, ref_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON whatsapp_slip_sends TO mandipos_api;

-- A fresh start's snapshot carries supplier_phones too.
CREATE OR REPLACE FUNCTION sync_reset(p_shop uuid, p_device uuid) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE r bigint; t text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_shop::text, 0));
  DELETE FROM changes WHERE shop_id = p_shop;
  r := sync_append(p_shop, '_reset', gen_random_uuid(), jsonb_build_object('at', now()), p_device);
  UPDATE shop_counters SET reset_seq = r WHERE shop_id = p_shop;
  FOREACH t IN ARRAY ARRAY['brands', 'rates', 'buyers', 'trucks', 'truck_grades', 'bills', 'bill_lines', 'bill_voids',
                           'delivery_slips', 'receivings', 'lading_slips', 'collections', 'collection_voids', 'spoilage',
                           'daybook_entries', 'day_closes', 'terminal_payments', 'udhaar_entries', 'labour_adjustments',
                           'pickups', 'staff', 'supplier_phones'] LOOP
    EXECUTE format(
      'INSERT INTO changes (shop_id, seq, table_name, row_id, row, device_id)
       SELECT $1, (SELECT last_seq FROM shop_counters WHERE shop_id = $1) + row_number() OVER (ORDER BY x.id), %L, x.id, to_jsonb(x), x.device_id
       FROM %I x WHERE x.shop_id = $1', t, t) USING p_shop;
    UPDATE shop_counters SET last_seq = (SELECT max(seq) FROM changes WHERE shop_id = p_shop) WHERE shop_id = p_shop;
  END LOOP;
  INSERT INTO changes (shop_id, seq, table_name, row_id, row, device_id)
  SELECT p_shop, (SELECT last_seq FROM shop_counters WHERE shop_id = p_shop) + row_number() OVER (ORDER BY k.buyer_id), 'kyc', k.buyer_id, kyc_feed_row(k), k.device_id
  FROM buyer_kyc k WHERE k.shop_id = p_shop;
  UPDATE shop_counters SET last_seq = (SELECT max(seq) FROM changes WHERE shop_id = p_shop) WHERE shop_id = p_shop;
  RETURN r;
END $$;
REVOKE ALL ON FUNCTION sync_reset(uuid, uuid) FROM PUBLIC;
