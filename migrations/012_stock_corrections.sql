-- A miscount at arrival is not spoilage.
--
-- When a gaadi was entered with more nuts than it carried ("minus 1200 nuts from the Madras
-- vehicle — the count was entered wrong"), the only way to take them off was Phoota, which
-- then read as 1,200 rotten nuts in the register. A lot row is a fact and cannot go negative,
-- so the fix rides on spoilage — the table that already takes nuts off a gaadi — with a kind
-- that says why. Stock arithmetic is unchanged; only what the shop is shown differs.
--
-- (A count that was too LOW needs nothing here: the terminal adds another lot line.)

ALTER TABLE spoilage ADD COLUMN kind text NOT NULL DEFAULT 'spoiled'
  CHECK (kind IN ('spoiled', 'correction'));

UPDATE changes c SET row = to_jsonb(x) FROM spoilage x
  WHERE c.table_name = 'spoilage' AND c.row_id = x.id;
