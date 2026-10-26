# MandiPlus Dashboard (Windows)

The MandiPOS owners' portal (https://mandipos-admin.onrender.com, code in `mandipos-api/admin`) in
its own window. Go + WebView2 (wailsapp/go-webview2 bindings, no CGO), cross-compiled on the Mac.

- The window loads the live portal, so every portal deploy reaches the app at once.
- The exe updates itself from mandipos-api `app_releases` (flavor `desktop`): checked 20 s after
  start and every 6 h, sha256-checked, swapped in place, runs from the next start. A build that
  never shows a page in 3 starts is swapped back out (`update-skip.txt`).
- First run copies itself to `%LOCALAPPDATA%\MandiPlus Dashboard`, adds Desktop + Start menu
  shortcuts and an Apps & features entry (`--uninstall`). Data (login, WebView2 profile, log) lives there.
- Camera / mic / clipboard are allowed for the portal; outside links, `tel:` and WhatsApp go to
  Windows; blob: PDFs open in WebView2's own window; no network → a retry page.
- Without WebView2 (old Windows 7/8): Edge or Chrome in `--app` mode, else Microsoft's installer.

## Build and ship

    ./build.sh 0.1.1          # dist/MandiPlus Dashboard.exe + a mac binary for updater tests
    cd .. && DATABASE_URL_DIRECT=… PGSSLROOTCERT=system npm run -s publish-desktop -- "desktop/dist/MandiPlus Dashboard.exe" 0.1.1 "notes"

The version passed to publish must be the one built in. Download: mandiplus.com/dashboard-app.

## Test

No Windows machine here: the `desktop-smoke` workflow runs the published exe (or, with
`build`, this folder at that commit) on a GitHub Windows runner (smoke from inside the page, real install, screenshots; with `from_run` it
updates an earlier run's exe). Flags: `--smoke <file>`, `--update-now <file>`, `--home <dir>`,
`--no-install`, `--debug` (DevTools), `--url`.
