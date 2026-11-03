# cozmo-field-logger

Field data-collection web app for the Simply Cozmo – Dabouq 1 simulation study. Spec: [APP_SPEC.md](APP_SPEC.md).

Static files only (no build step). Served by GitHub Pages from the repo root of `main`.

- v0.1.0 (Session 1): setup, counter mode (Deli / Butchery / Bakery), snapshots, CSV export, offline app shell.
- v0.2.0 (Session 2): undo + edit a time, checkout service and checkout arrivals modes, per-lane snapshots, "Snapshot due" badge, wake lock, self-updating Home Screen app.
- Not built yet: Apps Script sync, `pivot_events.py`. Export the CSV at the end of every session.

Test locally (needs Playwright + Chromium):

    node tests/smoke.test.js
    node tests/session2.test.js

On every deploy that changes a shell file: bump `APP_VERSION` in `config.js` and `CACHE` in `sw.js`.
An installed app picks up the new version on its next online launch (it reloads itself on the setup screen; during a running session it waits until "New session").
