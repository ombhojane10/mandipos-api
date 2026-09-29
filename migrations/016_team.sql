-- A shop is run by more than one person.
--
-- Admins (role 'owner') and accountants (role 'munim') see and do the same books; only the
-- team itself — who is in it, who is admin — is an admin's to change. People join two ways:
-- the admin adds their mobile number (their first login lands in the shop), or they type the
-- shop's 6-digit join code.

ALTER TABLE shops ADD COLUMN join_code text UNIQUE CHECK (join_code ~ '^[0-9]{6}$');

DO $$
DECLARE s record; c text;
BEGIN
  FOR s IN SELECT id FROM shops WHERE join_code IS NULL LOOP
    LOOP
      c := lpad((floor(random() * 1000000))::int::text, 6, '0');
      EXIT WHEN NOT EXISTS (SELECT 1 FROM shops WHERE join_code = c);
    END LOOP;
    UPDATE shops SET join_code = c WHERE id = s.id;
  END LOOP;
END $$;

-- Removing someone from the team is a delete of their membership.
GRANT DELETE ON shop_members TO mandipos_api;
