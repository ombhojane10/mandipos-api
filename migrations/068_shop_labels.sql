-- The MandiPlus admin console's own name for a shop ("Ashish Azadpur"), to tell two shops of
-- the same name apart. Website only — the app never reads it.
ALTER TABLE shops ADD COLUMN nickname text NOT NULL DEFAULT '';
