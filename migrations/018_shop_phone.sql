-- The mobile number printed on the shop's slips.
--
-- Slips printed whatever number was logged in on that terminal, so an accountant's own phone
-- ended up on the shop's letterhead. The shop now has its own, set by an admin; it starts as
-- the number that registered the shop.

ALTER TABLE shops ADD COLUMN phone text NOT NULL DEFAULT '' CHECK (phone = '' OR phone ~ '^[6-9][0-9]{9}$');
UPDATE shops s SET phone = u.phone FROM users u WHERE u.id = s.created_by AND s.phone = '';
