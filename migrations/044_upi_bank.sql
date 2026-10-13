-- Which of the shop's bank accounts a UPI payment landed in, as the counter picked it:
-- the account's label ("ICICI ··4521"). '' = not said (cash, or no bank set up). Kept as the
-- label, not a reference, so a bank removed from Settings later still names its old payments.
ALTER TABLE bills ADD COLUMN upi_bank text NOT NULL DEFAULT '';
ALTER TABLE collections ADD COLUMN upi_bank text NOT NULL DEFAULT '';
