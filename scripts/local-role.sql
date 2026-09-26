-- Re-grants the LOCAL development role after a migration adds tables.
--
-- Production's runtime role is `mandipos_api` and the migrations grant to it by name. A local
-- database is created with its own role (`mandipos_app`), which those grants miss, so a new
-- table fails at runtime with "not allowed for this shop" (Postgres 42501) until this runs.
-- Local only: never point it at Neon.
--
--   psql -d mandipos_local -v role=mandipos_app -f scripts/local-role.sql

DO $$
DECLARE
  dev text := current_setting('my.role', true);
  t   text;
BEGIN
  IF dev IS NULL OR dev = '' THEN RAISE EXCEPTION 'set -v role=<local role>'; END IF;
  FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO %I', t, dev);
    -- Policies are per role, so the dev role needs its own copy of the shop rule — but only
    -- where the migrations actually put one. Enabling RLS anywhere else (devices, for one)
    -- locks out writes that happen before a shop is known, i.e. logging in.
    IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'shop_isolation')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'shop_isolation_dev')
    THEN
      EXECUTE format(
        'CREATE POLICY shop_isolation_dev ON %I TO %I
           USING (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)
           WITH CHECK (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)', t, dev);
    END IF;
  END LOOP;
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', dev);
END $$;
