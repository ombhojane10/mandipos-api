-- Nariyal Supplier Ledger: a cut ("Kaat") or a corrected remaining ("Baaki badla") on what the
-- shop owes a supplier for his Purchase gaadis, typed on the app's Home > Supplier Ledger page.
-- Not money moved, so no book, galla, Hisab, creditors or dashboard reads it; only that page and
-- its printed ledger do. Money actually paid stays a daybook "supplier" line, as before.
--   amount_paise > 0  the baaki comes down by it (kaat, or baaki set lower)
--   amount_paise < 0  the baaki goes up by it   (baaki set higher)
-- A master: a human types it and may take it back (hidden). Each is for one Purchase gaadi (truck_id).
--
-- Every gaadi arrival is its own bill, so a supplier with two gaadis (even the same vehicle number
-- on two trips) has two bills. A supplier payment says which bill it is for in purchase_bill:
--   NULL       not a Supplier Ledger payment (Gaadiyan › Supplier, or older lines) — left out of it
--   <truck id> that Purchase gaadi's bill
--   'account'  his oldest unpaid Purchase gaadi first; what is left over waits for his next one

ALTER TABLE daybook_entries ADD COLUMN purchase_bill text
  CHECK (purchase_bill IS NULL OR purchase_bill = 'account' OR length(purchase_bill) = 36);

CREATE TABLE supplier_adjustments (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  truck_id       uuid NOT NULL,
  party_name     text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('kaat', 'badla')),
  note           text NOT NULL DEFAULT '',
  amount_paise   bigint NOT NULL CHECK (amount_paise <> 0),
  business_date  date NOT NULL,
  hidden         boolean NOT NULL DEFAULT false,
  device_id      uuid NOT NULL REFERENCES devices(id),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

CREATE INDEX supplier_adjustments_shop ON supplier_adjustments (shop_id);

GRANT SELECT, INSERT, UPDATE ON supplier_adjustments TO mandipos_api;

ALTER TABLE supplier_adjustments ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON supplier_adjustments TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

-- A fresh start's snapshot carries them too (078's function, with this table added).
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
                           'pickups', 'staff', 'supplier_phones', 'breakages', 'office_entries', 'supplier_adjustments'] LOOP
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
