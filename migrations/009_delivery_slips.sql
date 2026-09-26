-- The delivery slip is its own thing, and it is often made later.
--
-- The counter bills first and only afterwards learns the goods are going out with a rickshaw —
-- "make me a delivery slip for that parchi". A bill is written once and never edited, so the
-- delivery cannot be a column on it: it is a row of its own, created whenever the shop decides,
-- carrying where *this* load went (which is not always the customer's usual address).

CREATE TABLE delivery_slips (
  id           uuid PRIMARY KEY,
  shop_id      uuid NOT NULL REFERENCES shops(id),
  bill_id      uuid NOT NULL,
  -- Where this load went. Blank means the slip carries only the name and the count.
  address      text NOT NULL DEFAULT '',
  destination  text NOT NULL DEFAULT '',
  device_id    uuid NOT NULL REFERENCES devices(id),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, bill_id) REFERENCES bills (shop_id, id),
  UNIQUE (shop_id, id)
);

CREATE INDEX delivery_slips_bill ON delivery_slips (shop_id, bill_id);

GRANT SELECT, INSERT, UPDATE ON delivery_slips TO mandipos_api;

ALTER TABLE delivery_slips ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON delivery_slips TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

-- Slips already marked as deliveries get their row, so nothing that was sent out before today
-- looks undelivered afterwards.
INSERT INTO delivery_slips (id, shop_id, bill_id, address, destination, device_id, created_by, created_at)
SELECT gen_random_uuid(), b.shop_id, b.id, COALESCE(y.address, ''), COALESCE(y.destination, ''),
       b.device_id, b.created_by, b.created_at
FROM bills b LEFT JOIN buyers y ON y.id = b.buyer_id
WHERE b.delivery;
