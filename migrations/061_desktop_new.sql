-- MandiPlus Dashboard New for Windows: the same WebView2 shell on the new-look beta portal, a
-- separate app with its own releases, so a shop can keep the Tally-look one beside it.
ALTER TABLE app_releases DROP CONSTRAINT app_releases_flavor_check;
ALTER TABLE app_releases ADD CONSTRAINT app_releases_flavor_check CHECK (flavor IN ('pos', 'daybook', 'tally', 'admin', 'desktop', 'desktop-new'));
