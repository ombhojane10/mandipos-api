-- A second commodity: amrud (guava), sold on commission for the parties who bring it.
--
-- The shop picks its commodity once, when it is registered, and every terminal of the shop
-- follows it. Tender coconut ("nariyal") is what every shop so far deals in.
--
-- Amrud adds one charge to the customer: chungi, a fixed amount per box (₹10). It prints on
-- the slip as its own line and is part of total_paise, so udhaar and baaki already count it;
-- chungi_paise keeps the part that was chungi so a report can tell it from the goods.

ALTER TABLE shops ADD COLUMN commodity text NOT NULL DEFAULT 'nariyal' CHECK (commodity IN ('nariyal', 'amrud'));

ALTER TABLE bills ADD COLUMN chungi_paise bigint NOT NULL DEFAULT 0 CHECK (chungi_paise >= 0);
