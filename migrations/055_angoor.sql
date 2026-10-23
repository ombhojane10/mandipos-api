-- A third commodity: angoor (grapes), sold on commission like amrud — a party sends boxes of
-- several qualities (Royal, Rocket, Tiger…) on a gaadi, the shop sells them and settles the party.
--
-- What grapes adds on top of the amrud model:
-- * trucks.location: where the gaadi stands in the mandi ("Pillar 320, Shed 11"). The labour
--   hands out boxes there, so the slip prints it next to the vehicle number.
-- * truck_grades.box_grams: the box's weight (10 kg box = 10000); 0 = not said.
-- * bills.apmc_paise: 1% market fee on the goods, kept for the shop's books only. It is NOT part
--   of total_paise and never printed on the customer's slip.
-- * pickups: boxes collected at the gaadi against a slip, scanned off the slip's QR. An order of
--   40 can go 20 now and 20 later; what's left to pick up is the slip's qty minus these.
-- * spoilage kinds 'store' (boxes sent back to cold storage, the note carries the box/bay no.)
--   and 'broken' (broken crates).
-- * staff: accountants with their own passcode; a slip records who wrote it, and a voided or
--   edited slip records who did that (bill_voids.staff_name), so every change has a name on it.
--   shops.staff_backup_code opens the lock when an accountant's own code is forgotten.

ALTER TABLE shops DROP CONSTRAINT shops_commodity_check;
ALTER TABLE shops ADD CONSTRAINT shops_commodity_check CHECK (commodity IN ('nariyal', 'amrud', 'angoor'));
ALTER TABLE shops ADD COLUMN staff_backup_code text NOT NULL DEFAULT '99' CHECK (staff_backup_code ~ '^[0-9]{2,8}$');

ALTER TABLE trucks ADD COLUMN location text NOT NULL DEFAULT '';
ALTER TABLE truck_grades ADD COLUMN box_grams integer NOT NULL DEFAULT 0 CHECK (box_grams >= 0);
ALTER TABLE bills ADD COLUMN apmc_paise bigint NOT NULL DEFAULT 0 CHECK (apmc_paise >= 0);
ALTER TABLE bill_voids ADD COLUMN staff_name text NOT NULL DEFAULT '';

ALTER TABLE spoilage DROP CONSTRAINT spoilage_kind_check;
ALTER TABLE spoilage ADD CONSTRAINT spoilage_kind_check CHECK (kind IN ('spoiled', 'correction', 'store', 'broken'));
ALTER TABLE spoilage ADD COLUMN note text NOT NULL DEFAULT '';

CREATE TABLE pickups (
  id           uuid PRIMARY KEY,
  shop_id      uuid NOT NULL REFERENCES shops(id),
  bill_id      uuid NOT NULL,
  qty          integer NOT NULL CHECK (qty > 0),
  note         text NOT NULL DEFAULT '',
  device_id    uuid NOT NULL REFERENCES devices(id),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);
CREATE INDEX pickups_bill ON pickups (shop_id, bill_id);

GRANT SELECT, INSERT ON pickups TO mandipos_api;
ALTER TABLE pickups ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON pickups TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

CREATE TABLE staff (
  id           uuid PRIMARY KEY,
  shop_id      uuid NOT NULL REFERENCES shops(id),
  name         text NOT NULL CHECK (btrim(name) <> ''),
  passcode     text NOT NULL DEFAULT '',
  hidden       boolean NOT NULL DEFAULT false,
  device_id    uuid NOT NULL REFERENCES devices(id),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);

GRANT SELECT, INSERT, UPDATE ON staff TO mandipos_api;
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON staff TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

-- A fresh start's snapshot carries the two new tables too.
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
                           'pickups', 'staff'] LOOP
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
