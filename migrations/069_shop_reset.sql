-- "Data reset" from the app's Settings (an admin, with the reset PIN): every business row of the
-- shop goes — grahak, suppliers, gaadis, parchi, payments, hisab, logs — and the shop starts
-- fresh. The shop itself, its settings, team, machines, staff passcodes and its masters (maal,
-- groups, heads, stores, crate types, areas) stay.
--
-- Nothing is lost for good: every removed row is kept, as JSON per table, in shop_resets.archive,
-- so a mistaken reset can be put back by hand. Runs as the owner (SECURITY DEFINER) because the
-- API's own role may never delete money rows; the API may only call this one function.
CREATE TABLE shop_resets (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id    uuid NOT NULL REFERENCES shops(id),
  by_user    uuid REFERENCES users(id),
  by_device  uuid,
  at         timestamptz NOT NULL DEFAULT now(),
  counts     jsonb NOT NULL,
  archive    jsonb NOT NULL
);
CREATE INDEX shop_resets_shop ON shop_resets (shop_id, at DESC);

CREATE FUNCTION reset_shop_data(p_shop uuid, p_user uuid, p_device uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  keep text[] := ARRAY['shops', 'shop_members', 'devices', 'shop_counters', 'changes', 'shop_resets',
                       'staff', 'brands', 'brand_groups', 'product_groups', 'ledger_heads', 'stores', 'crate_types', 'areas',
                       'print_stations', 'machines', 'machine_events'];
  pending text[]; later text[]; t text; got jsonb; pass int := 0;
  counts jsonb := '{}'; archive jsonb := '{}';
BEGIN
  -- The push lock: no terminal's slip lands half-way through.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_shop::text, 0));
  SELECT coalesce(array_agg(c.table_name::text ORDER BY c.table_name), '{}') INTO pending
  FROM information_schema.columns c
  JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public' AND c.column_name = 'shop_id' AND NOT (c.table_name::text = ANY (keep));

  FOREACH t IN ARRAY pending LOOP
    EXECUTE format('SELECT coalesce(jsonb_agg(to_jsonb(x)), ''[]''::jsonb) FROM %I x WHERE x.shop_id = $1', t) INTO got USING p_shop;
    IF jsonb_array_length(got) > 0 THEN
      archive := archive || jsonb_build_object(t, got);
      counts := counts || jsonb_build_object(t, jsonb_array_length(got));
    END IF;
  END LOOP;

  -- Children before parents: a table still referenced waits for the next pass.
  WHILE cardinality(pending) > 0 LOOP
    pass := pass + 1;
    IF pass > 25 THEN RAISE EXCEPTION 'reset_shop_data: still referenced: %', pending; END IF;
    later := '{}';
    FOREACH t IN ARRAY pending LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE shop_id = $1', t) USING p_shop;
      EXCEPTION WHEN foreign_key_violation THEN later := later || t;
      END;
    END LOOP;
    pending := later;
  END LOOP;

  INSERT INTO shop_resets (shop_id, by_user, by_device, counts, archive) VALUES (p_shop, p_user, p_device, counts, archive);
  -- Every terminal wipes its copy and pulls what is left.
  PERFORM sync_reset(p_shop, p_device);
  RETURN counts;
END $$;
REVOKE ALL ON FUNCTION reset_shop_data(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reset_shop_data(uuid, uuid, uuid) TO mandipos_api;
