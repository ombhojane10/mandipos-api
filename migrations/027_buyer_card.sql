-- The RFID/NFC card a grahak carries: its serial number (UID, upper-case hex) as the terminal
-- reads it. Tapping the card on the counter's machine opens that grahak. Nothing is written to
-- the card; the link lives here so every terminal in the shop knows the same card.

ALTER TABLE buyers ADD COLUMN card text NOT NULL DEFAULT '';
