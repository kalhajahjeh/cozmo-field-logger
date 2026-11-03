// Cozmo Field Logger — configuration.
// APPS_SCRIPT_URL and TOKEN are filled in Session 2 (sync), after Karam deploys
// the Apps Script. They are intentionally empty in Session 1: the app works
// fully offline and exports CSV without them.
window.CFL_CONFIG = {
  APP_VERSION: '0.2.0',
  APPS_SCRIPT_URL: '',
  TOKEN: '',
  TZ_OFFSET: '+03:00',          // APP_SPEC §3: ISO 8601 with +03:00 (Asia/Amman)
  SNAPSHOT_INTERVAL_S: 600      // APP_SPEC §4.5: every 10 minutes
};
