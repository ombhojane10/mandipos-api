-- A grahak's opening balance can be on either side. Positive is purana udhaar (they owe the
-- shop); negative is jama — money the shop holds for them, the CREDIT column of the shop's
-- trial balance. Terminals count jama like money already received: it pays their slips off,
-- but it is never cash or UPI taken on any day, so the galla and Hisab don't move.
ALTER TABLE udhaar_entries DROP CONSTRAINT udhaar_entries_amount_paise_check;
ALTER TABLE udhaar_entries ADD CONSTRAINT udhaar_entries_amount_paise_check CHECK (amount_paise <> 0);
