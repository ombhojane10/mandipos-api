-- Signed APKs the terminals and phones update themselves from, so a new build no longer
-- needs a USB cable at every shop. Published from the laptop with `npm run publish-apk`,
-- which connects as the owner; the API only ever reads.
--
-- The APK sits in the row. It is ~9 MB, a handful of releases a week, and the API keeps
-- the newest one in memory, so the database is read once per release per server boot.
CREATE TABLE app_releases (
  flavor        text NOT NULL CHECK (flavor IN ('pos', 'daybook')),
  version_code  int NOT NULL CHECK (version_code > 0),
  version_name  text NOT NULL,
  sha256        text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes    int NOT NULL CHECK (size_bytes > 0),
  apk           bytea NOT NULL,
  notes         text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flavor, version_code)
);

GRANT SELECT ON app_releases TO mandipos_api;
