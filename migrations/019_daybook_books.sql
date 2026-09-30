-- The daybook is three books, not one — the way the shop already keeps them on paper.
--
--   cash    the phad's galla: what the munim holds. "Rajnish can only enter whatever cash
--           he has with him."
--   office  cash that reaches the malik directly at the office (a committee paid in, rent
--           paid out) — kept apart "so if Rajnish says tomorrow it didn't come to me…"
--   upi / bank  the bank. "Only me and Virender bhaiya make entries in the diary… no
--           accountant can enter bank transactions."
--
-- Who may write which book is checked where rows arrive (sync), not here: an accountant
-- ('munim') writes cash lines only, never an opening balance, and never touches a line
-- someone else wrote. Money moving between books (galla → malik, office → bank) is one row in
-- the book it left, with a category naming where it went; the other book reads it from there.

ALTER TABLE daybook_entries DROP CONSTRAINT IF EXISTS daybook_entries_mode_check;
ALTER TABLE daybook_entries ADD CONSTRAINT daybook_entries_mode_check
  CHECK (mode IN ('cash', 'office', 'upi', 'bank'));
