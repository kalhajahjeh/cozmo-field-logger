// Headless smoke test for Session 1. Run from the repo root:
//   node tests/smoke.test.js
// Serves the repo on localhost, drives the app in Chromium (iPhone-sized),
// and fails on any console error or broken expectation.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const OUT = process.env.OUT_DIR || path.join(ROOT, 'tests', 'out');

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log('  ok   ' + msg);
  else { failures++; console.log('  FAIL ' + msg); }
}

async function tap(page, sel) { await page.locator(sel).first().click(); await page.waitForTimeout(60); }

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));

  console.log('Load + setup');
  await page.goto(base);
  await page.waitForSelector('#in-observer');
  await page.evaluate(() => navigator.serviceWorker.ready);
  check(await page.locator('[data-action="start-session"]').isDisabled(), 'start disabled until name + station');
  check(!(await page.locator('[data-arg="Checkout service"]').isDisabled()) &&
    !(await page.locator('[data-arg="Checkout arrivals"]').isDisabled()), 'checkout modes enabled (v0.2.0)');
  await page.fill('#in-observer', 'Tester');
  await tap(page, '[data-arg="Deli"]');
  await page.fill('[data-emp="0"]', 'red cap, left scale');
  await tap(page, '[data-action="add-e4"]');
  await page.screenshot({ path: path.join(OUT, '1-setup.png') });
  await tap(page, '[data-action="start-session"]');
  await page.waitForSelector('[data-action="arrival"]');

  console.log('Counter mode');
  for (let i = 0; i < 3; i++) await tap(page, '[data-action="arrival"]');
  check(await page.locator('.card').count() === 3, '3 open cards after 3 arrivals');
  check(await page.locator('.card.next[data-seq="1"]').count() === 1, 'NEXT on #1 before any completed service');
  await tap(page, '.card[data-seq="1"] [data-action="start"]');
  check(await page.locator('[data-action="pick-emp"]').count() === 4, 'picker shows E1-E4');
  await tap(page, '[data-action="pick-emp"][data-arg="E2"]');
  await tap(page, '.card[data-seq="1"] [data-action="order"][data-arg="1:S"]');
  await tap(page, '.card[data-seq="1"] [data-action="items-inc"]');
  await tap(page, '.card[data-seq="1"] [data-action="items-inc"]');
  await tap(page, '.card[data-seq="1"] [data-action="interrupt"]');
  await page.screenshot({ path: path.join(OUT, '2-counter.png') });
  await tap(page, '.card[data-seq="1"] [data-action="end"]');
  await tap(page, '.card[data-seq="2"] [data-action="balk"]');
  check(await page.locator('.card').count() === 1, 'only #3 open after end + balk');
  check(await page.locator('.card.next').count() === 0, 'no NEXT: #3 arrived before the last completed service');
  await tap(page, '[data-action="arrival"]');
  check(await page.locator('.card.next[data-seq="4"]').count() === 1, 'NEXT on #4 (first arrival after last service_end)');
  await tap(page, '.card[data-seq="3"] [data-action="dismiss"]');
  check(await page.locator('.card').count() === 1, 'not-timed dismiss closes #3');

  console.log('Snapshot (manual)');
  await tap(page, '[data-action="snapshot-open"]');
  await tap(page, '[data-action="snap-inc"][data-arg="queue"]');
  await tap(page, '[data-action="snap-inc"][data-arg="queue"]');
  await tap(page, '[data-action="snap-inc"][data-arg="serving"]');
  await page.screenshot({ path: path.join(OUT, '3-snapshot.png') });
  await tap(page, '[data-action="snap-save"]');

  const before = await page.evaluate(() => window.CFL_TEST.state().events.length);
  // session_start, 4 arrivals, service_start, 3 edits, interruption, service_end, balk, snapshot = 13
  check(before === 13, `13 events logged (got ${before})`);

  console.log('Force-quit + offline reopen');
  await ctx.setOffline(true);
  await page.close();
  const page2 = await ctx.newPage();
  page2.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page2.on('pageerror', (e) => errors.push(String(e)));
  await page2.goto(base);
  await page2.waitForSelector('[data-action="arrival"]');
  const after = await page2.evaluate(() => window.CFL_TEST.state().events.length);
  check(after === before, `session resumed offline with all ${after} events`);
  check(await page2.locator('.card').count() === 1 && await page2.locator('.card.next[data-seq="4"]').count() === 1, 'open cards + NEXT restored');
  check(await page2.locator('.dot.bad').count() === 1, 'red dot while offline');
  await tap(page2, '[data-action="arrival"]');
  check((await page2.locator('[data-action="arrival"] .sub').textContent()).startsWith('Customer #6 '), 'customer numbering continues');

  console.log('End session + CSV');
  await tap(page2, '[data-action="end-session-ask"]');
  await tap(page2, '[data-action="end-session-confirm"]');
  await page2.waitForSelector('[data-action="export"]');
  await page2.screenshot({ path: path.join(OUT, '4-summary.png') });
  const csv = await page2.evaluate(() => window.CFL_TEST.buildCsv(window.CFL_TEST.state().events));
  fs.writeFileSync(path.join(OUT, 'export.csv'), csv);
  const lines = csv.trim().split('\r\n');
  check(lines[0] === 'event_id,session_id,observer,station,device_id,event_type,customer_seq,lane,employee,order_type,items,basket,pay,queue_len,employees_serving,employees_idle,registers_open,target_event_id,new_timestamp,timestamp,elapsed_s,note,app_version', 'CSV header matches §5 exactly');
  check(lines.length === 16, `CSV has header + 15 events (got ${lines.length - 1})`);
  check(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+03:00$/.test(lines[1].split(',')[19]), 'timestamp ISO 8601 + ms + +03:00');
  await page2.close();

  console.log('Scheduled snapshot prompt (fake clock +10 min)');
  const page3 = await ctx.newPage();
  page3.on('pageerror', (e) => errors.push(String(e)));
  await page3.clock.install();
  await page3.goto(base);
  await tap(page3, '[data-action="new-session"]');
  await page3.fill('#in-observer', 'Tester');
  await tap(page3, '[data-arg="Butchery"]');
  await tap(page3, '[data-action="start-session"]');
  await page3.waitForSelector('[data-action="arrival"]');
  check(await page3.locator('.overlay').count() === 0, 'no prompt at start');
  await page3.clock.runFor(10 * 60 * 1000 + 1000);
  check(await page3.locator('.overlay .alarm').count() === 1, 'full-screen amber prompt at 10:00');
  await tap(page3, '[data-action="snap-close"]');
  check(await page3.locator('.overlay').count() === 0 && await page3.locator('.btn.amber[data-action="snapshot-open"]').count() === 1, 'closed prompt leaves amber Snapshot button');
  await tap(page3, '[data-action="snapshot-open"]');
  await tap(page3, '[data-action="snap-save"]');
  check(await page3.locator('.btn.amber').count() === 0, 'amber cleared after save');
  await page3.clock.runFor(10 * 60 * 1000);
  check(await page3.locator('.overlay .alarm').count() === 1, 'prompt again at 20:00');

  check(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  srv.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
