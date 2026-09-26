-- Two things the shop asked for that the parchi alone does not carry.
--
-- 1. The rickshaw driver brings back a signed receiving: "he delivered the goods here, meaning
--    he didn't deliver it to the wrong place". That is a separate event, hours after the slip,
--    so it is its own insert-once row rather than an edit to the slip.
-- 2. Their register ran to 800-950 names, many long dead, and "if an excess list is visible, it
--    causes even more problems" — so a customer can be taken off the list without deleting the
--    history that refers to them.

CREATE TABLE receivings (
  id           uuid PRIMARY KEY,
  shop_id      uuid NOT NULL REFERENCES shops(id),
  bill_id      uuid NOT NULL,
  -- Who signed for it, when the driver names them; blank when nobody wrote it down.
  received_by  text NOT NULL DEFAULT '',
  note         text NOT NULL DEFAULT '',
  device_id    uuid NOT NULL REFERENCES devices(id),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, bill_id) REFERENCES bills (shop_id, id),
  UNIQUE (shop_id, id)
);

CREATE INDEX receivings_bill ON receivings (shop_id, bill_id);

ALTER TABLE buyers ADD COLUMN hidden boolean NOT NULL DEFAULT false;

GRANT SELECT, INSERT, UPDATE ON receivings TO mandipos_api;

ALTER TABLE receivings ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON receivings TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

-- Terminals rebuild their copy from `changes`, so buyers pushed before today must carry the
-- new column too (see 004 for why).
UPDATE changes c SET row = to_jsonb(x) FROM buyers x
  WHERE c.table_name = 'buyers' AND c.row_id = x.id;
