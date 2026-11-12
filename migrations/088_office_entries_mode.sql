-- Office Aaya-Gaya (Ashish Brothers, nariyal): how the money moved, Cash or UPI, chosen in the
-- sheet's dropdown. Every line written before this was cash. Still nothing but that one screen
-- (and the final daybook's office part) reads the table.
ALTER TABLE office_entries ADD COLUMN mode text NOT NULL DEFAULT 'cash' CHECK (mode IN ('cash', 'upi'));
