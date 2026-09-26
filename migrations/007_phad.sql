-- It is the phad, not the fard: the stall number that prints under the firm name.
-- Renamed while the column holds a single shop's value, before anything else reads it.

ALTER TABLE shops RENAME COLUMN fard TO phad;
