-- "After payment": the slip is written and the dana set aside, but the maal goes out only once
-- the grahak has paid. Owed like udhaar until then; the mode says why the dana is still here.
ALTER TABLE bills DROP CONSTRAINT bills_pay_mode_check;
ALTER TABLE bills ADD CONSTRAINT bills_pay_mode_check
  CHECK (pay_mode IN ('cash', 'upi', 'card', 'credit', 'mixed', 'after'));

-- The shop's three katta: green (10 dana), jaipur (20) and white (25), which is new.
ALTER TABLE bills DROP CONSTRAINT bills_packing_check;
ALTER TABLE bills ADD CONSTRAINT bills_packing_check
  CHECK (packing IN ('loose', 'katta10', 'katta15', 'katta20', 'katta25', 'panni'));
