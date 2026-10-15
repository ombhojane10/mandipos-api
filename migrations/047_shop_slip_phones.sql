-- More numbers for the slip's head, after the shop's own phone (and dispatch's): Mohit Jaipur
-- prints three. Ten-digit mobiles only, in the order they print.
ALTER TABLE shops ADD COLUMN slip_phones text[] NOT NULL DEFAULT '{}'
  CHECK (array_to_string(slip_phones, ',') ~ '^([6-9][0-9]{9}(,[6-9][0-9]{9})*)?$');
