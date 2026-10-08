-- A collection can be deleted, and corrected under its own raseed number.
--
-- "There's no edit / delete option in the collection slips." Collections are money rows the
-- runtime role never updates or deletes, and that stays true — as with slips (migration 013),
-- cancelling is its own insert-once fact, a void, one per collection row, and the terminals
-- drop a voided row from their books when they pull it. The row itself remains here.
--
-- An edit is voids plus fresh rows carrying the SAME receipt number — the grahak's raseed says
-- 673, and 673 it must stay. The unique index on (shop_id, receipt_no) would refuse that, so it
-- becomes a trigger: a number may be used again once every earlier row holding it is voided.
-- Pushes for a shop are serialised by an advisory lock, and a device sends the voids and the
-- new rows in one txn, voids first.

CREATE TABLE collection_voids (
  id             uuid PRIMARY KEY,
  shop_id        uuid NOT NULL REFERENCES shops(id),
  -- No foreign key: a void must never be refused because its row reached the server late.
  collection_id  uuid NOT NULL,
  -- Kept on the void so a cancelled raseed reads as cancelled, not missing.
  receipt_no     int,
  reason         text NOT NULL DEFAULT 'deleted' CHECK (reason IN ('deleted', 'edited')),
  device_id      uuid NOT NULL REFERENCES devices(id),
  created_by     uuid NOT NULL REFERENCES users(id),
  created_at     timestamptz NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, collection_id),
  UNIQUE (shop_id, id)
);

GRANT SELECT, INSERT ON collection_voids TO mandipos_api;

ALTER TABLE collection_voids ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON collection_voids TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

DROP INDEX collections_receipt_no;
CREATE INDEX collections_receipt_no ON collections (shop_id, receipt_no) WHERE receipt_no IS NOT NULL;

CREATE FUNCTION collections_receipt_no_unique() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.receipt_no IS NOT NULL AND EXISTS (
    SELECT 1 FROM collections c
     WHERE c.shop_id = NEW.shop_id AND c.receipt_no = NEW.receipt_no AND c.id <> NEW.id
       AND NOT EXISTS (SELECT 1 FROM collection_voids v WHERE v.shop_id = c.shop_id AND v.collection_id = c.id)
  ) THEN
    RAISE EXCEPTION 'receipt % already used', NEW.receipt_no
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'collections_receipt_no';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER collections_receipt_no_unique BEFORE INSERT ON collections
  FOR EACH ROW EXECUTE FUNCTION collections_receipt_no_unique();

-- A fresh start's snapshot carries the voids too, after the rows they cancel.
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
                           'daybook_entries', 'day_closes', 'terminal_payments', 'udhaar_entries'] LOOP
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
