-- The Tally connector (a Windows zip) is published and downloaded the same way as the POS APKs:
-- mandiplus.com/tally-connector links to the public download, which serves the newest one.
ALTER TABLE app_releases DROP CONSTRAINT app_releases_flavor_check;
ALTER TABLE app_releases ADD CONSTRAINT app_releases_flavor_check CHECK (flavor IN ('pos', 'daybook', 'tally'));
