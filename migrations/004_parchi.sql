-- The parchi: what the counter actually writes, as the traders at Azadpur described it.
--
-- Shown the app on 2026-09-25, the shop (Ashish Brothers, B-142) asked for their own slip
-- rather than a bill: a serial number they can cross-check at night, the vehicle the nuts
-- came off, the customer, grade rows, the packing labour they recover, and Cash/UPI split —
-- no khata. A second print, the delivery slip, goes with the rickshaw and carries no rates,
-- only where the goods are headed, which is why buyers now keep an address.
--
-- `total_paise` from here on is goods **plus** labour, i.e. what the customer owes, so the
-- existing paid <= total check still holds once packing charges are on the slip.

-- ---------------------------------------------------------------- the slip

ALTER TABLE bills
  -- Sequential per shop from 1. The night check is "no number missing", so it is the slip's
  -- identity for the trader; `number` stays the GST-style series for anyone who needs it.
  ADD COLUMN slip_no      int CHECK (slip_no > 0),
  -- One slip sells off one vehicle: that is how the shop knows which truck ran short.
  ADD COLUMN truck_id     uuid,
  -- Cash and UPI on the same slip: part now in cash, the rest on the phone, is routine.
  ADD COLUMN cash_paise   bigint NOT NULL DEFAULT 0 CHECK (cash_paise >= 0),
  ADD COLUMN upi_paise    bigint NOT NULL DEFAULT 0 CHECK (upi_paise >= 0),
  -- Packing/counting labour the shop recovers from the customer; part of total_paise.
  ADD COLUMN labour_paise bigint NOT NULL DEFAULT 0 CHECK (labour_paise >= 0),
  ADD COLUMN packing      text NOT NULL DEFAULT 'loose'
             CHECK (packing IN ('loose', 'katta10', 'katta20', 'panni')),
  -- How many kattas or pannis were tied: labour is this times the shop's per-katta rate.
  ADD COLUMN packs        int NOT NULL DEFAULT 0 CHECK (packs >= 0),
  -- Whether a delivery slip was printed for the rickshaw; "bina delivery slip" is common.
  ADD COLUMN delivery     boolean NOT NULL DEFAULT false,
  -- Who made the slip. It prints on the accountant signature line.
  ADD COLUMN staff_name   text NOT NULL DEFAULT '';

ALTER TABLE bills ADD CONSTRAINT bills_truck_fk
  FOREIGN KEY (shop_id, truck_id) REFERENCES trucks (shop_id, id);

CREATE UNIQUE INDEX bills_slip_no ON bills (shop_id, slip_no) WHERE slip_no IS NOT NULL;

-- A slip can now be part cash and part UPI.
ALTER TABLE bills DROP CONSTRAINT bills_pay_mode_check;
ALTER TABLE bills ADD CONSTRAINT bills_pay_mode_check
  CHECK (pay_mode IN ('cash', 'upi', 'card', 'credit', 'mixed'));

-- Existing rows: what was paid went through whichever single mode they carried.
UPDATE bills SET cash_paise = paid_paise WHERE pay_mode = 'cash';
UPDATE bills SET upi_paise  = paid_paise WHERE pay_mode IN ('upi', 'card');

-- ---------------------------------------------------------------- where the goods go

-- The rickshaw driver needs the shop number and the stand, not a phone number: "Wasim" is
-- four different customers, and it is the address that tells them apart.
ALTER TABLE buyers
  ADD COLUMN address     text NOT NULL DEFAULT '',
  ADD COLUMN destination text NOT NULL DEFAULT '';

-- ---------------------------------------------------------------- history

-- `changes` keeps the row as it looked when it was pushed, and terminals rebuild their copy
-- from it — so without this, every bill written before today would pull back missing its new
-- columns and show as unpaid. Re-snapshot them from the tables the columns just landed on.
UPDATE changes c SET row = to_jsonb(b) FROM bills b
  WHERE c.table_name = 'bills' AND c.row_id = b.id;
UPDATE changes c SET row = to_jsonb(x) FROM buyers x
  WHERE c.table_name = 'buyers' AND c.row_id = x.id;
