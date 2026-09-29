-- Two more ways the maal leaves the counter.
--
-- A 15-nut katta, beside the 10 and 20. And a panni is not just "panni": the shop packs
-- into named bags (Nariyal Pani, Jai Ho, AB, Organic), and the name goes on the slip so the
-- loader picks the right stack. Blank for anything that isn't a panni.

ALTER TABLE bills DROP CONSTRAINT bills_packing_check;
ALTER TABLE bills ADD CONSTRAINT bills_packing_check
  CHECK (packing IN ('loose', 'katta10', 'katta15', 'katta20', 'panni'));

ALTER TABLE bills ADD COLUMN panni_name text NOT NULL DEFAULT '';

-- Terminals rebuild from `changes`, so older bills must carry the new column too.
UPDATE changes c SET row = to_jsonb(x) FROM bills x
  WHERE c.table_name = 'bills' AND c.row_id = x.id;
