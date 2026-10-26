-- MandiPlus Dashboard for Windows: a WebView2 window on the owners' portal (the screens are the
-- website's, so they update with it). The exe itself is published and downloaded like the APKs.
ALTER TABLE app_releases DROP CONSTRAINT app_releases_flavor_check;
ALTER TABLE app_releases ADD CONSTRAINT app_releases_flavor_check CHECK (flavor IN ('pos', 'daybook', 'tally', 'admin', 'desktop'));
