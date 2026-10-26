-- Angoor: boxes found broken after they left the gaadi, and the labour who reports them.
--
-- * shop_members.role 'labour': a login that only scans slips at the gaadi — hands boxes over and
--   reports broken ones. The app opens on Scan alone; the sync accepts only pickups and
--   breakages from it.
-- * breakages: "10 of this slip's Royal came back broken", raised by scanning the slip again.
--   It waits (pending) for the accountant, who writes the broken boxes at a lower bhav: the slip
--   is rewritten under its own number (the old one voided as 'edited'), and the request is
--   marked done with the new bill and bhav — or rejected. A master row, so the status travels.

ALTER TABLE shop_members DROP CONSTRAINT shop_members_role_check;
ALTER TABLE shop_members ADD CONSTRAINT shop_members_role_check CHECK (role IN ('owner', 'manager', 'munim', 'labour'));

CREATE TABLE breakages (
  id                uuid PRIMARY KEY,
  shop_id           uuid NOT NULL REFERENCES shops(id),
  bill_id           uuid NOT NULL,
  slip_no           integer,
  brand_id          uuid,
  truck_id          uuid,
  qty               integer NOT NULL CHECK (qty > 0),
  note              text NOT NULL DEFAULT '',
  reported_by       text NOT NULL DEFAULT '',
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'rejected')),
  rate_paise        bigint NOT NULL DEFAULT 0 CHECK (rate_paise >= 0),
  resolved_bill_id  uuid,
  resolved_by       text NOT NULL DEFAULT '',
  device_id         uuid NOT NULL REFERENCES devices(id),
  created_by        uuid NOT NULL REFERENCES users(id),
  created_at        timestamptz NOT NULL,
  updated_at        timestamptz NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);
CREATE INDEX breakages_open ON breakages (shop_id, status, created_at);

GRANT SELECT, INSERT, UPDATE ON breakages TO mandipos_api;
ALTER TABLE breakages ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON breakages TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

-- A fresh start's snapshot carries breakages too.
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
                           'pickups', 'staff', 'supplier_phones', 'breakages'] LOOP
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
