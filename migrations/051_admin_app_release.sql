-- The owners' app: the admin portal packaged as an Android app (a Trusted Web Activity, so the
-- screens are the website's and update with it). Published and downloaded like the POS APKs.
ALTER TABLE app_releases DROP CONSTRAINT app_releases_flavor_check;
ALTER TABLE app_releases ADD CONSTRAINT app_releases_flavor_check CHECK (flavor IN ('pos', 'daybook', 'tally', 'admin'));
