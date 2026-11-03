-- Cheeku: a gaadi closes by itself once its maal is gone — every box sold (or taken off), and
-- every box of every slip on it handed over at the gaadi. Until the last box is handed over the
-- labour still need it on "Gaadi kahan". Closed like the app's "Gaadi band karein": it leaves
-- New slip and Gaadi kahan, its books stay, and it can be opened again by hand.
--
-- Called after each push (a terminal's or the website's) with the gaadis and slips it touched;
-- the closed rows go onto the shop's feed, so every machine drops the gaadi in a second or two.
CREATE FUNCTION cheeku_autoclose(p_shop uuid, p_trucks uuid[], p_bills uuid[], p_device uuid) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE
  t uuid;
  closed int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM shops WHERE id = p_shop AND commodity = 'cheeku') THEN RETURN 0; END IF;
  FOR t IN
    SELECT tr.id FROM trucks tr
    WHERE tr.shop_id = p_shop AND tr.closed_at IS NULL
      AND (tr.id = ANY(p_trucks) OR tr.id IN (SELECT l.truck_id FROM bill_lines l WHERE l.shop_id = p_shop AND l.bill_id = ANY(p_bills)))
  LOOP
    CONTINUE WHEN (
      WITH recv AS (
        SELECT COALESCE((SELECT SUM(received_qty) FROM truck_grades WHERE shop_id = p_shop AND truck_id = t), 0)
             - COALESCE((SELECT SUM(qty) FROM spoilage WHERE shop_id = p_shop AND truck_id = t AND kind = 'correction'), 0) AS n
      ), gone AS (
        SELECT COALESCE((SELECT SUM(l.qty) FROM bill_lines l WHERE l.shop_id = p_shop AND l.truck_id = t
                          AND NOT EXISTS (SELECT 1 FROM bill_voids v WHERE v.bill_id = l.bill_id)), 0)
             + COALESCE((SELECT SUM(qty) FROM spoilage WHERE shop_id = p_shop AND truck_id = t AND kind <> 'correction'), 0) AS n
      )
      -- Nothing counted in (boxes to follow), or maal still to sell: stays open.
      SELECT recv.n <= 0 OR recv.n - gone.n > 0 FROM recv, gone
    );
    -- A slip on this gaadi with boxes still to hand over: stays open.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM bills b
      WHERE b.shop_id = p_shop AND NOT EXISTS (SELECT 1 FROM bill_voids v WHERE v.bill_id = b.id)
        AND EXISTS (SELECT 1 FROM bill_lines l WHERE l.bill_id = b.id AND l.truck_id = t)
        AND (SELECT COALESCE(SUM(qty), 0) FROM bill_lines l WHERE l.bill_id = b.id)
          > (SELECT COALESCE(SUM(qty), 0) FROM pickups p WHERE p.bill_id = b.id)
    );
    UPDATE trucks SET closed_at = now(), updated_at = now() WHERE shop_id = p_shop AND id = t;
    PERFORM sync_append(p_shop, 'trucks', t, (SELECT to_jsonb(x) FROM trucks x WHERE x.shop_id = p_shop AND x.id = t), p_device);
    closed := closed + 1;
  END LOOP;
  RETURN closed;
END $$;
