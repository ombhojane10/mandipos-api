-- Mazdoori typed in by hand: the palledars' earnings added to (a load the slips don't show) or
-- taken off (a slip's mazdoori that shouldn't count). "Have option to add majdoori as well, so i
-- can manually edit the mazdoori." Positive adds, negative takes off. It is earned labour, not
-- money moved, so no book (galla, bank, office) ever reads it — only Mazdoori and Hisab do.
-- A master: a human types it and may take it back (hidden).

CREATE TABLE labour_adjustments (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  amount_paise   bigint NOT NULL CHECK (amount_paise <> 0),
  note           text NOT NULL DEFAULT '',
  business_date  date NOT NULL,
  hidden         boolean NOT NULL DEFAULT false,
  device_id      uuid NOT NULL REFERENCES devices(id),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

CREATE INDEX labour_adjustments_day ON labour_adjustments (shop_id, business_date);

GRANT SELECT, INSERT, UPDATE ON labour_adjustments TO mandipos_api;

ALTER TABLE labour_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON labour_adjustments TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

-- A fresh start's snapshot carries them too.
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
                           'daybook_entries', 'day_closes', 'terminal_payments', 'udhaar_entries', 'labour_adjustments'] LOOP
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
