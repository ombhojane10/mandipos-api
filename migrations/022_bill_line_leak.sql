-- Leak: cracked, leaking nuts sold off the same gaadi for one lump sum. The counter types the
-- dana and the total; the bhav is worked out from them. A leak line is an ordinary sale line
-- (it comes off the gaadi's stock under a real grade) with this flag, so the slip and the
-- books can say "Leak" instead of I/II/III.

ALTER TABLE bill_lines ADD COLUMN leak boolean NOT NULL DEFAULT false;
