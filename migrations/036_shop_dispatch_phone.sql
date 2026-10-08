-- A second number for the slip's head: the dispatch desk, beside the accountant's (shops.phone).
-- '' = none; the slip then prints the one number as before.
ALTER TABLE shops ADD COLUMN dispatch_phone text NOT NULL DEFAULT ''
  CHECK (dispatch_phone = '' OR dispatch_phone ~ '^[6-9][0-9]{9}$');
