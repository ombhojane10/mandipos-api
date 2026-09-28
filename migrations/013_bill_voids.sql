-- A slip can be cancelled, and corrected under its own number.
--
-- "When I create an order slip, the confirmation page… have 2 options, edit / delete." A bill
-- is a money row the runtime role can never update or delete, and that stays true: cancelling
-- is its own insert-once fact, a void, and the terminals drop a voided slip from their books
-- when they pull it. The row itself remains here, so what was written and what was cancelled
-- can both be read back.
--
-- An edit is a void plus a fresh bill carrying the SAME slip number — the customer's copy says
-- #12, and #12 it must stay. The plain unique index on (shop_id, slip_no) would refuse that,
-- so it becomes a trigger: a number may be used again only once every earlier bill holding it
-- has been voided. Pushes for a shop are already serialised by an advisory lock, so two
-- terminals cannot both slip through the check.

CREATE TABLE bill_voids (
  id           uuid PRIMARY KEY,
  shop_id      uuid NOT NULL REFERENCES shops(id),
  bill_id      uuid NOT NULL,
  -- Kept on the void so the night's "koi parchi gayab" check can read #12 as cancelled, not missing.
  slip_no      int,
  -- 'deleted' when the slip was simply cancelled, 'edited' when a corrected one replaced it.
  reason       text NOT NULL DEFAULT 'deleted' CHECK (reason IN ('deleted', 'edited')),
  device_id    uuid NOT NULL REFERENCES devices(id),
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, bill_id) REFERENCES bills (shop_id, id),
  UNIQUE (shop_id, bill_id),
  UNIQUE (shop_id, id)
);

GRANT SELECT, INSERT ON bill_voids TO mandipos_api;

ALTER TABLE bill_voids ENABLE ROW LEVEL SECURITY;
CREATE POLICY shop_isolation ON bill_voids TO mandipos_api
  USING (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid)
  WITH CHECK (shop_id = nullif(current_setting('app.shop_id', true), '')::uuid);

DROP INDEX bills_slip_no;
CREATE INDEX bills_slip_no ON bills (shop_id, slip_no) WHERE slip_no IS NOT NULL;

CREATE FUNCTION bills_slip_no_unique() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.slip_no IS NOT NULL AND EXISTS (
    SELECT 1 FROM bills b
     WHERE b.shop_id = NEW.shop_id AND b.slip_no = NEW.slip_no AND b.id <> NEW.id
       AND NOT EXISTS (SELECT 1 FROM bill_voids v WHERE v.shop_id = b.shop_id AND v.bill_id = b.id)
  ) THEN
    RAISE EXCEPTION 'slip % already used', NEW.slip_no
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'bills_slip_no';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER bills_slip_no_unique BEFORE INSERT ON bills
  FOR EACH ROW EXECUTE FUNCTION bills_slip_no_unique();
