// Headless tests for v0.2.0 (Session 2). Run from the repo root:
//   node tests/session2.test.js
// Covers: undo, edit a time, checkout service, checkout arrivals, per-lane
// snapshots, "Snapshot due" badge, wake lock fallback, version + app update.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const OUT = process.env.OUT_DIR || path.join(ROOT, 'tests', 'out');
let swOverride = null; // simulate a new deploy: serve sw.js with a different CACHE name

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      if (p === '/sw.js' && swOverride) {
        res.end(fs.readFileSync(f, 'utf8').replace(/var CACHE = '[^']+';/, `var CACHE = '${swOverride}';`));
        return;
      }
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
const ev = (page) => page.evaluate(() => window.CFL_TEST.state().events.map((e) => {
  const o = {}; window.CFL_TEST.COLS.forEach((k) => { o[k] = e[k]; }); return o;
}));
const live = (page) => page.evaluate(() => window.CFL_TEST.state().live.map((e) => e.event_type));
const errors = [];
function watch(page) {
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
}
async function newSession(page, station, lanes) {
  if (await page.locator('[data-action="new-session"]').count()) await tap(page, '[data-action="new-session"]');
  await page.fill('#in-observer', 'Tester');
  await tap(page, `[data-action="pick-station"][data-arg="${station}"]`);
  for (const l of lanes || []) await tap(page, `[data-action="setup-lane"][data-arg="${l}"]`);
}
async function endSession(page) {
  await tap(page, '[data-action="end-session-ask"]');
  await tap(page, '[data-action="end-session-confirm"]');
  await page.waitForSelector('[data-action="export"]');
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}/`;
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true });
  const page = await ctx.newPage();
  watch(page);

  console.log('Setup screen');
  await page.goto(base);
  await page.waitForSelector('#in-observer');
  await page.evaluate(() => navigator.serviceWorker.ready);
  check((await page.locator('#app-version').textContent()) === 'v0.2.0', 'setup screen shows v0.2.0');
  await page.fill('#in-observer', 'Tester');
  await tap(page, '[data-arg="Deli"]');
  check((await page.locator('[data-emp="0"]').getAttribute('placeholder')) === 'appearance or position, not a name', 'E1 placeholder: appearance or position, not a name');
  await tap(page, '[data-arg="Checkout service"]');
  check(await page.locator('[data-emp="0"]').count() === 0, 'employee fields hidden for checkout');
  check(await page.locator('[data-action="start-session"]').isDisabled(), 'checkout service needs 2 lanes');
  for (const l of ['2', '3', '5']) await tap(page, `[data-action="setup-lane"][data-arg="${l}"]`);
  check(await page.locator('[data-action="setup-lane"].on').count() === 2, '3rd lane pick keeps the 2 most recent (3, 5)');
  await page.screenshot({ path: path.join(OUT, 's2-1-setup-service.png') });

  console.log('Undo (counter)');
  await newSession(page, 'Deli');
  await tap(page, '[data-action="start-session"]');
  await page.waitForSelector('[data-action="arrival"]');
  check(await page.locator('[data-action="undo"]').isDisabled(), 'undo disabled when nothing to undo');
  for (let i = 0; i < 3; i++) await tap(page, '[data-action="arrival"]');
  check((await page.locator('[data-action="undo"] .sub').textContent()) === '#3 arrival', 'undo label names the target (#3 arrival)');
  await tap(page, '[data-action="undo"]');
  check(await page.locator('.card').count() === 2, 'undo ARRIVAL removes the card');
  check(await page.locator('.toast').count() === 1, 'toast confirms the undo');
  check((await page.locator('[data-action="arrival"] .sub').textContent()).startsWith('Customer #4 '), 'customer numbers are not reused after undo');
  await tap(page, '.card[data-seq="1"] [data-action="start"]');
  await tap(page, '[data-action="pick-emp"][data-arg="E1"]');
  await tap(page, '.card[data-seq="1"] [data-action="items-inc"]');
  await tap(page, '.card[data-seq="1"] [data-action="items-inc"]');
  await tap(page, '[data-action="undo"]');
  check((await page.locator('.card[data-seq="1"] .stepval').textContent()) === '1', 'undo items edit: 2 -> 1');
  await tap(page, '[data-action="undo"]');
  await tap(page, '[data-action="undo"]');
  check(await page.locator('.card[data-seq="1"] [data-action="start"]').count() === 1, 'undo START returns the card to waiting');
  let e = await ev(page);
  const undos = e.filter((x) => x.event_type === 'undo');
  check(undos.length === 4 && undos.every((u) => u.target_event_id), '4 undo events, each with target_event_id');
  check(e.length === 1 + 3 + 1 + 2 + 4, 'nothing deleted: every event is still in the log');

  console.log('Edit a time');
  const arrivalId = e.find((x) => x.event_type === 'arrival' && x.customer_seq === 1).event_id;
  const origTs = e.find((x) => x.event_id === arrivalId).timestamp;
  await tap(page, '.card[data-seq="1"] [data-action="edit-timer"]');
  check(await page.locator('.overlay [data-action="edit-save"]').isDisabled(), 'save disabled until the time changes');
  await tap(page, '[data-action="edit-adj"][data-arg="-10"]');
  await tap(page, '[data-action="edit-adj"][data-arg="-1"]');
  await page.screenshot({ path: path.join(OUT, 's2-2-edit-time.png') });
  await tap(page, '[data-action="edit-save"]');
  e = await ev(page);
  let edit = e[e.length - 1];
  check(edit.event_type === 'edit' && edit.target_event_id === arrivalId, 'edit event targets the arrival');
  check(Date.parse(edit.new_timestamp) === Date.parse(origTs) - 11000, 'new_timestamp = original − 11 s');
  check(/\+03:00$/.test(edit.new_timestamp), 'new_timestamp has +03:00');
  const effArrival = await page.evaluate(() => window.CFL_TEST.state().customers[1].arrivalMs);
  check(effArrival === Date.parse(origTs) - 11000, 'card wait timer uses the edited time');
  await tap(page, '[data-action="edit-open"]');
  check(await page.locator('.lrow').count() >= 2, 'edit list shows recent time events');
  await tap(page, `.lrow[data-arg="${arrivalId}"]`);
  await page.fill('#in-settime', '99');
  await tap(page, '[data-action="edit-set"]');
  check(await page.locator('.errtext').count() === 1, 'bad typed time shows an error');
  await page.fill('#in-settime', '173205');
  await tap(page, '[data-action="edit-set"]');
  check((await page.locator('#edit-new').textContent()) === '17:32:05', 'typed 173205 sets 17:32:05');
  await tap(page, '[data-action="edit-save"]');
  e = await ev(page);
  edit = e[e.length - 1];
  check(edit.new_timestamp === origTs.slice(0, 10) + 'T17:32:05.000+03:00', 'direct set logs exact new_timestamp');
  check((await page.locator('[data-action="undo"] .sub').textContent()) === '#1 arrival time', 'undo label for a time edit');
  await tap(page, '[data-action="undo"]');
  check(await page.evaluate(() => window.CFL_TEST.state().customers[1].arrivalMs) === Date.parse(origTs) - 11000, 'undo time edit restores the previous edit');

  console.log('Summary counts exclude undone');
  await endSession(page);
  check((await page.locator('.kv[data-type="arrival"] b').textContent()) === '2', 'summary: 2 arrivals (1 undone)');
  check((await page.locator('.kv[data-type="undo"] b').textContent()) === '5', 'summary: 5 undo rows');
  check((await page.locator('.kv[data-type="service_start"] b').textContent()) === '0', 'summary: undone start not counted');

  console.log('Checkout service');
  await newSession(page, 'Checkout service', []);
  check(await page.locator('[data-action="setup-lane"].on').count() === 2, 'service lanes remembered from last setup');
  await tap(page, '[data-action="start-session"]');
  await page.waitForSelector('[data-action="join"]');
  check(await page.locator('[data-action="join"]').count() === 2, 'two JOIN buttons');
  await tap(page, '[data-action="join"][data-arg="3"]');
  await tap(page, '[data-action="join"][data-arg="3"]');
  await tap(page, '[data-action="join"][data-arg="5"]');
  check(await page.locator('.lanecol[data-lane="3"] .ccard').count() === 2 && await page.locator('.lanecol[data-lane="5"] .ccard').count() === 1, 'cards land in their lane column');
  await tap(page, '.ccard[data-seq="1"] [data-action="basket"][data-arg="1:T"]');
  await tap(page, '.ccard[data-seq="1"] [data-action="start"]');
  await tap(page, '.ccard[data-seq="1"] [data-action="interrupt"]');
  await tap(page, '.ccard[data-seq="1"] [data-action="pay"][data-arg="1:K"]');
  await page.screenshot({ path: path.join(OUT, 's2-3-service.png') });
  // tap targets >= 56 px wide and tall in the 2-column layout at 375 px
  const small = await page.$$eval('.ccard .btn, .band.tools .btn', (bs) => bs.filter((b) => {
    const r = b.getBoundingClientRect(); return r.width < 55.5 || r.height < 55.5;
  }).length);
  check(small === 0, 'all card + tool buttons >= 56 px at 375 px width');
  check(await page.evaluate(() => document.documentElement.scrollWidth <= 375), 'no horizontal overflow');
  await tap(page, '.ccard[data-seq="1"] [data-action="end"]');
  check(await page.locator('.ccard[data-seq="1"]').count() === 0, 'END closes the card');
  await tap(page, '[data-action="undo"]');
  check(await page.locator('.ccard[data-seq="1"] [data-action="end"]').count() === 1, 'undo END reopens the card');
  await tap(page, '[data-action="join"][data-arg="5"]');
  await tap(page, '[data-action="undo"]');
  check(await page.locator('.lanecol[data-lane="5"] .ccard').count() === 1, 'undo JOIN removes the card');
  await tap(page, '[data-action="snapshot-open"]');
  check(await page.locator('[data-action="snap-inc"][data-arg="q:3"]').count() === 1 && await page.locator('[data-action="snap-inc"][data-arg="q:5"]').count() === 1, 'snapshot has a queue stepper per lane');
  await tap(page, '[data-action="snap-inc"][data-arg="q:3"]');
  await tap(page, '[data-action="snap-inc"][data-arg="q:3"]');
  await tap(page, '[data-action="snap-inc"][data-arg="q:5"]');
  await tap(page, '[data-action="snap-inc"][data-arg="registers"]');
  await tap(page, '[data-action="snap-save"]');
  e = await ev(page);
  const join1 = e.find((x) => x.event_type === 'join' && x.customer_seq === 1);
  check(join1.lane === '3', 'join logged with lane');
  check(e.some((x) => x.event_type === 'edit' && x.target_event_id === join1.event_id && x.basket === 'T'), 'basket = edit on the join event');
  check(e.some((x) => x.event_type === 'edit' && x.target_event_id === join1.event_id && x.pay === 'K'), 'pay = edit on the join event');
  check(e.some((x) => x.event_type === 'service_start' && x.customer_seq === 1 && x.lane === '3'), 'service_start with lane');
  check(e.some((x) => x.event_type === 'interruption' && x.customer_seq === 1 && x.lane === '3'), 'interruption with lane');
  const snap = e[e.length - 1];
  check(snap.event_type === 'snapshot' && snap.queue_len === '2/1' && snap.lane === '3/5' && snap.registers_open === 1, `snapshot queue_len "2/1", lane "3/5", registers 1 (got ${snap.queue_len}, ${snap.lane}, ${snap.registers_open})`);
  check(/lanes watched: 3\/5/.test(e[0].note), 'session_start note records lanes watched');
  await endSession(page);
  await page.screenshot({ path: path.join(OUT, 's2-4-service-summary.png') });

  console.log('Checkout arrivals');
  await newSession(page, 'Checkout arrivals', ['1', '2', '4']);
  await tap(page, '[data-action="start-session"]');
  await page.waitForSelector('[data-action="join-lane"]');
  e = await ev(page);
  check(e.filter((x) => x.event_type === 'lane_open').map((x) => x.lane).join(',') === '1,2,4', 'lane_open logged for each lane open at start');
  check(await page.locator('[data-action="join-lane"]').count() === 4, '3 lane buttons + Other lane');
  await tap(page, '[data-action="join-lane"][data-arg="1"]');
  await tap(page, '[data-action="join-lane"][data-arg="1"]');
  await tap(page, '[data-action="join-lane"][data-arg="other"]');
  check((await page.locator('[data-action="join-lane"][data-arg="1"] .cnt').textContent()) === '2', 'lane 1 shows 2 in the current bin');
  await tap(page, '[data-action="undo"]');
  check((await page.locator('[data-action="join-lane"][data-arg="other"] .cnt').textContent()) === '0', 'undo join removes it from the count');
  await page.screenshot({ path: path.join(OUT, 's2-5-arrivals.png') });
  await tap(page, '[data-action="lanes-open"]');
  await tap(page, '[data-action="lane-toggle"][data-arg="4"]');
  await tap(page, '[data-action="lane-toggle"][data-arg="7"]');
  await tap(page, '[data-action="lanes-close"]');
  check(await page.locator('[data-action="join-lane"][data-arg="4"]').count() === 0 && await page.locator('[data-action="join-lane"][data-arg="7"]').count() === 1, 'close lane 4 / open lane 7 updates the buttons');
  e = await ev(page);
  check(e.some((x) => x.event_type === 'lane_close' && x.lane === '4') && e.some((x) => x.event_type === 'lane_open' && x.lane === '7'), 'lane_close / lane_open events logged');
  await tap(page, '[data-action="snapshot-open"]');
  await tap(page, '[data-action="snap-inc"][data-arg="q:7"]');
  check((await page.locator('.stepper:has([data-arg="registers"]) .stepval').textContent()) === '3', 'registers open defaults to open lane count');
  await tap(page, '[data-action="snap-save"]');
  e = await ev(page);
  const s2 = e[e.length - 1];
  check(s2.queue_len === '0/0/1' && s2.lane === '1/2/7', `arrivals snapshot queue_len "0/0/1" lane "1/2/7" (got ${s2.queue_len} / ${s2.lane})`);
  check(e.filter((x) => x.event_type === 'join').every((x) => x.customer_seq === ''), 'arrivals joins have no customer_seq');
  await endSession(page);
  check((await page.locator('.kv[data-type="join"] b').textContent()) === '2', 'summary: 2 joins (1 undone)');
  await page.close();

  console.log('5-minute bins + Snapshot due badge (fake clock)');
  const p3 = await ctx.newPage();
  watch(p3);
  await p3.clock.install({ time: new Date('2026-11-04T17:03:00+03:00') });
  await p3.goto(base);
  await newSession(p3, 'Checkout arrivals', []);
  await tap(p3, '[data-action="start-session"]');
  await p3.waitForSelector('[data-action="join-lane"]');
  check((await p3.locator('.binbar .title').textContent()) === 'Bin 17:00–17:05', 'bin aligned to the clock (17:00–17:05)');
  await tap(p3, '[data-action="join-lane"][data-arg="1"]');
  await p3.clock.runFor(2 * 60 * 1000 + 1000);
  check((await p3.locator('.binbar .title').textContent()) === 'Bin 17:05–17:10', 'bin rolls over at 17:05');
  check((await p3.locator('[data-action="join-lane"][data-arg="1"] .cnt').textContent()) === '0', 'count resets for the new bin');
  check((await p3.locator('[data-action="join-lane"][data-arg="1"] .sub').textContent()).includes('total 1'), 'session total kept');
  await p3.clock.runFor(8 * 60 * 1000);
  check(await p3.locator('.overlay .alarm').count() === 1, 'snapshot prompt at 10:00');
  const nBefore = (await ev(p3)).length;
  await tap(p3, '[data-action="snap-close"]');
  check((await ev(p3)).length === nBefore, 'closing the prompt logs nothing');
  check(await p3.locator('[data-action="snapshot-open"].amber .badge').textContent() === 'DUE', 'Snapshot button shows DUE badge');
  await p3.screenshot({ path: path.join(OUT, 's2-6-due-badge.png') });
  await p3.reload();
  await p3.waitForSelector('[data-action="join-lane"]');
  await p3.clock.runFor(1000);
  check(await p3.locator('.overlay').count() === 0 && await p3.locator('[data-action="snapshot-open"] .badge').count() === 1, 'after force-quit: badge kept, prompt not re-shown');
  await tap(p3, '[data-action="snapshot-open"]');
  await tap(p3, '[data-action="snap-save"]');
  check(await p3.locator('[data-action="snapshot-open"] .badge').count() === 0, 'badge cleared after save');
  const w = await p3.evaluate(() => window.CFL_TEST.wake());
  check(w.held || w.tip, `wake lock held or Auto-Lock tip shown (held=${w.held}, tip=${w.tip})`);
  await endSession(p3);
  check(!(await p3.evaluate(() => window.CFL_TEST.wake())).held, 'wake lock released at session end');
  await p3.close();

  console.log('App update (new sw.js deployed)');
  const p4 = await ctx.newPage();
  watch(p4);
  await p4.goto(base);
  await tap(p4, '[data-action="new-session"]');
  await p4.waitForSelector('#in-observer');
  await p4.evaluate(() => navigator.serviceWorker.ready);
  await p4.evaluate(() => { window.__old = true; });
  swOverride = 'cfl-shell-test-update-1';
  const nav = p4.waitForEvent('load', { timeout: 10000 }).then(() => true, () => false);
  await p4.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  check(await nav, 'setup screen reloads itself when a new version takes over');
  check(await p4.evaluate(() => window.__old === undefined), 'page is a fresh load');
  // During a running session: no reload; it waits for New session.
  await p4.waitForSelector('#in-observer');
  await newSession(p4, 'Deli');
  await tap(p4, '[data-action="start-session"]');
  await p4.waitForSelector('[data-action="arrival"]');
  await tap(p4, '[data-action="arrival"]');
  await p4.evaluate(() => { window.__old = true; });
  swOverride = 'cfl-shell-test-update-2';
  await p4.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => r.update()));
  await p4.waitForTimeout(2500);
  check(await p4.evaluate(() => window.__old === true), 'no reload during a running session');
  await endSession(p4);
  await p4.waitForTimeout(500);
  const nav2 = p4.waitForEvent('load', { timeout: 10000 }).then(() => true, () => false);
  await tap(p4, '[data-action="new-session"]');
  check(await nav2, 'update applied at New session');
  swOverride = null;

  check(errors.length === 0, 'no console errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
  await browser.close();
  srv.close();
  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
