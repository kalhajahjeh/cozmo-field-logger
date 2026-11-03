# cozmo-field-logger

Field data-collection web app for the Simply Cozmo – Dabouq 1 simulation study. Spec: [APP_SPEC.md](APP_SPEC.md).

Static files only (no build step). Served by GitHub Pages from the repo root of `main`.

- Session 1 (this version): setup, counter mode (Deli / Butchery / Bakery), snapshots, CSV export, offline app shell.
- Session 2: Apps Script sync, checkout modes, corrections, wake lock, `pivot_events.py`.

Test locally: `node tests/smoke.test.js` (needs Playwright + Chromium).
Bump `CACHE` in `sw.js` on every deploy that changes a shell file.
