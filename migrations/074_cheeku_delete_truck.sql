-- Cheeku: removing a gaadi that was entered by mistake or as a test, on every machine.
--
-- The API role may only append (034). Deleting synced rows is left to the owner role, so this one
-- narrow case gets its own function, run as the owner, in the same way as reset_shop_data (069).
-- It acts only on a cheeku shop's gaadi that nothing has used yet. Any table with a truck_id
-- (slip lines, bills, set-asides, breakages, beejaks, store entries, laddan bills, and any table
-- added later) blocks it. The gaadi's own quality rows are deleted along with it. Each delete goes
-- through sync_delete, so every terminal drops its copy.
--
-- Returns 'deleted', 'used' (something refers to the gaadi), 'not_found' or 'not_cheeku'.
CREATE FUNCTION cheeku_delete_truck(p_shop uuid, p_truck uuid, p_device uuid) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  t text;
  used boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop AND commodity = 'cheeku') THEN RETURN 'not_cheeku'; END IF;
  IF NOT EXISTS (SELECT 1 FROM trucks WHERE shop_id = p_shop AND id = p_truck) THEN RETURN 'not_found'; END IF;

  FOR t IN
    SELECT c.table_name FROM information_schema.columns c
    JOIN information_schema.tables tb ON tb.table_schema = c.table_schema AND tb.table_name = c.table_name AND tb.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.column_name = 'truck_id' AND c.table_name <> 'truck_grades'
      AND EXISTS (SELECT 1 FROM information_schema.columns s
                  WHERE s.table_schema = 'public' AND s.table_name = c.table_name AND s.column_name = 'shop_id')
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I WHERE shop_id = $1 AND truck_id = $2)', t) INTO used USING p_shop, p_truck;
    IF used THEN RETURN 'used'; END IF;
  END LOOP;

  PERFORM sync_delete(p_shop, 'truck_grades', g.id, p_device) FROM truck_grades g WHERE g.shop_id = p_shop AND g.truck_id = p_truck;
  PERFORM sync_delete(p_shop, 'trucks', p_truck, p_device);
  RETURN 'deleted';
END $$;

REVOKE ALL ON FUNCTION cheeku_delete_truck(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cheeku_delete_truck(uuid, uuid, uuid) TO mandipos_api;
