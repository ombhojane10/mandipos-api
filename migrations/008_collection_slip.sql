-- A payment taken on a slip belongs to that slip.
--
-- Vasooli was only ever booked to the customer and applied oldest-first, which is right for
-- somebody paying down an old account. But when the counter opens slip #5 and takes the money
-- for it, the money is for #5 — and the slip has to show it cleared, or the staff take it twice.
-- Payments with no slip against them keep the old oldest-first behaviour.

ALTER TABLE collections ADD COLUMN bill_id uuid;
ALTER TABLE collections ADD CONSTRAINT collections_bill_fk
  FOREIGN KEY (shop_id, bill_id) REFERENCES bills (shop_id, id);
CREATE INDEX collections_bill ON collections (shop_id, bill_id);

UPDATE changes c SET row = to_jsonb(x) FROM collections x
  WHERE c.table_name = 'collections' AND c.row_id = x.id;
