-- A free slip: dana given away at ₹0. Nothing is owed and nothing was paid, but the nuts left
-- the gaadi, so the slip is kept like any other — just never counted as udhaar.
ALTER TABLE bills DROP CONSTRAINT bills_pay_mode_check;
ALTER TABLE bills ADD CONSTRAINT bills_pay_mode_check
  CHECK (pay_mode IN ('cash', 'upi', 'card', 'credit', 'mixed', 'after', 'free'));
