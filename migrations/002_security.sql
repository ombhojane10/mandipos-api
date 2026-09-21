-- Runtime access for the API. Migrations run as the database owner; the API
-- connects as mandipos_app, which is subject to row-level security and cannot
-- UPDATE or DELETE money records (corrections are new rows).
--
-- On Neon, create the mandipos_app login role in the console/API before running
-- migrations; the NOLOGIN fallback below only exists so a fresh local database migrates.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mandipos_app') THEN
    CREATE ROLE mandipos_app NOLOGIN;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO mandipos_app;

-- Auth tables: no tenant yet at login time, so no RLS; the API scopes them in code.
GRANT SELECT, INSERT, UPDATE ON users, shops, shop_members, devices, sessions, otp_codes TO mandipos_app;

-- Sync bookkeeping.
GRANT SELECT, INSERT, UPDATE ON shop_counters TO mandipos_app;
GRANT SELECT, INSERT ON changes TO mandipos_app;

-- Masters: editable (last write wins).
GRANT SELECT, INSERT, UPDATE ON buyers, trucks TO mandipos_app;

-- Facts: insert-only.
GRANT SELECT, INSERT ON truck_grades, bills, bill_lines, lading_slips, collections,
  spoilage, day_closes, terminal_payments TO mandipos_app;

-- Row-level security: every tenant table only shows the shop set by the API with
-- set_config('app.shop_id', <uuid>, true) inside the current transaction.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shop_counters', 'changes', 'buyers', 'trucks', 'truck_grades', 'bills',
    'bill_lines', 'lading_slips', 'collections', 'spoilage', 'day_closes', 'terminal_payments']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY shop_isolation ON %I TO mandipos_app
         USING (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)
         WITH CHECK (shop_id = nullif(current_setting(''app.shop_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
