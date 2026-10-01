-- The party's account code from the shop's own books (CA4, CAA1, CHFC1…). Traders know a
-- regular by code as much as by name, so the counter can search by it and slips can carry it.

ALTER TABLE buyers ADD COLUMN code text NOT NULL DEFAULT '';
