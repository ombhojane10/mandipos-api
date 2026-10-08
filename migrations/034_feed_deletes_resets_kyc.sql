-- The change feed carries more than new rows, so a terminal never has to log out to see what
-- happened on the server:
--
-- * '_delete' {table, id}: a row the server removed (a wrong slip, a grahak taken off the list).
--   Terminals drop their copy; before this, a deleted row lived on every machine until logout.
-- * '_reset' {at}: the shop's books were started again. Everything the shop still has follows it
--   in the feed, so a terminal that reaches it clears its copy and rebuilds from the rows after
--   it. Unsent rows it wrote before `at` belong to the old books and are dropped; rows written
--   after (a slip made offline once the day had started again) are kept and sent. shop_counters.reset_seq is
--   where it sits: a terminal that sends an older one is told to pull before it may push.
-- * 'kyc': a grahak's eKYC as the counter needs it — Aadhaar last four, PAN status, which fingers
--   are on file — written by a trigger, so every way a KYC is saved or edited reaches all
--   terminals. Never the name, address, photo or documents: those stay sealed in buyer_kyc and
--   are fetched on demand.
--
-- Old terminals skip tables they don't know ('_delete', '_reset', 'kyc'), so this is safe to
-- ship before they update.

ALTER TABLE shop_counters ADD COLUMN reset_seq bigint NOT NULL DEFAULT 0;
ALTER TABLE buyer_kyc ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- One row onto the shop's feed, with the next sequence number, under the same per-shop lock as
-- /sync/push so numbers still commit in order.
CREATE FUNCTION sync_append(p_shop uuid, p_table text, p_row_id uuid, p_row jsonb, p_device uuid) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE s bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_shop::text, 0));
  UPDATE shop_counters SET last_seq = last_seq + 1 WHERE shop_id = p_shop RETURNING last_seq INTO s;
  IF s IS NULL THEN RAISE EXCEPTION 'no counter for shop %', p_shop; END IF;
  INSERT INTO changes (shop_id, seq, table_name, row_id, row, device_id) VALUES (p_shop, s, p_table, p_row_id, p_row, p_device);
  RETURN s;
END $$;

-- Admin: delete one synced row and tell every terminal. Children first is the caller's job
-- (a bill's lines before the bill); the foreign keys refuse anything else.
CREATE FUNCTION sync_delete(p_shop uuid, p_table text, p_id uuid, p_device uuid) RETURNS bigint
LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('DELETE FROM %I WHERE shop_id = $1 AND id = $2', p_table) USING p_shop, p_id;
  DELETE FROM changes WHERE shop_id = p_shop AND table_name = p_table AND row_id = p_id;
  RETURN sync_append(p_shop, '_delete', p_id, jsonb_build_object('table', p_table, 'id', p_id), p_device);
END $$;

CREATE FUNCTION kyc_feed_row(k buyer_kyc) RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'id', k.buyer_id, 'aadhaar_last4', k.aadhaar_last4, 'pan_status', k.pan_status,
    'fingers', (SELECT coalesce(jsonb_agg(f->>'finger'), '[]'::jsonb) FROM jsonb_array_elements(k.fingers) f)::text,
    'verified_at', k.verified_at, 'created_at', k.verified_at, 'updated_at', k.updated_at)
$$;

-- Every save and every finger edit of a KYC goes onto the feed, whichever API path made it.
-- (AFTER, so an INSERT … ON CONFLICT DO UPDATE puts one row on the feed, not one per attempt.)
CREATE FUNCTION buyer_kyc_touch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER buyer_kyc_touch BEFORE INSERT OR UPDATE ON buyer_kyc FOR EACH ROW EXECUTE FUNCTION buyer_kyc_touch();

CREATE FUNCTION buyer_kyc_to_feed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM sync_append(NEW.shop_id, 'kyc', NEW.buyer_id, kyc_feed_row(NEW), NEW.device_id);
  RETURN NULL;
END $$;
CREATE TRIGGER buyer_kyc_to_feed AFTER INSERT OR UPDATE ON buyer_kyc FOR EACH ROW EXECUTE FUNCTION buyer_kyc_to_feed();

-- Admin: start the shop's feed again from what the tables hold now. Run after deleting rows in
-- bulk (a fresh start): the old feed goes, '_reset' comes first, then a snapshot of every
-- synced table in parent-before-child order.
CREATE FUNCTION sync_reset(p_shop uuid, p_device uuid) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE r bigint; t text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(p_shop::text, 0));
  DELETE FROM changes WHERE shop_id = p_shop;
  r := sync_append(p_shop, '_reset', gen_random_uuid(), jsonb_build_object('at', now()), p_device);
  UPDATE shop_counters SET reset_seq = r WHERE shop_id = p_shop;
  FOREACH t IN ARRAY ARRAY['brands', 'rates', 'buyers', 'trucks', 'truck_grades', 'bills', 'bill_lines', 'bill_voids',
                           'delivery_slips', 'receivings', 'lading_slips', 'collections', 'spoilage', 'daybook_entries',
                           'day_closes', 'terminal_payments', 'udhaar_entries'] LOOP
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

-- The API (runtime role) only appends; deleting and resetting stay with the owner role.
REVOKE ALL ON FUNCTION sync_delete(uuid, text, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION sync_reset(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_append(uuid, text, uuid, jsonb, uuid) TO mandipos_api;
GRANT EXECUTE ON FUNCTION kyc_feed_row(buyer_kyc) TO mandipos_api;

-- KYCs saved before this: onto the feed once, so terminals learn who is already done.
DO $$
DECLARE k buyer_kyc;
BEGIN
  FOR k IN SELECT * FROM buyer_kyc ORDER BY verified_at LOOP
    PERFORM sync_append(k.shop_id, 'kyc', k.buyer_id, kyc_feed_row(k), k.device_id);
  END LOOP;
END $$;
