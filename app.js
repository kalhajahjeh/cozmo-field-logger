// Cozmo Field Logger — Session 1 (APP_SPEC §11):
// setup screen, counter mode, snapshots, CSV export, offline app shell.
// Every tap that records data writes one event to the store BEFORE the UI
// changes (APP_SPEC §2.1). State is always rebuilt by replaying events, so a
// force-quit loses nothing (Acceptance test 2).
(function () {
  'use strict';

  var CFG = window.CFL_CONFIG;
  var DB = window.CFL_DB;

  // APP_SPEC §5 — column order is the CSV / Sheet header, exactly.
  var COLS = ['event_id', 'session_id', 'observer', 'station', 'device_id', 'event_type',
    'customer_seq', 'lane', 'employee', 'order_type', 'items', 'basket', 'pay', 'queue_len',
    'employees_serving', 'employees_idle', 'registers_open', 'target_event_id', 'new_timestamp',
    'timestamp', 'elapsed_s', 'note', 'app_version'];

  var STATIONS = [
    { name: 'Deli', mode: 'counter' },
    { name: 'Butchery', mode: 'counter' },
    { name: 'Bakery', mode: 'counter' },
    { name: 'Checkout service', mode: 'checkout-service' },   // Session 2
    { name: 'Checkout arrivals', mode: 'checkout-arrivals' }  // Session 2
  ];
  var BUILT_MODES = { counter: true };
  var ORDER_TYPES = ['S', 'W', 'P', 'M'];

  // ---------------------------------------------------------------- meta (localStorage)
  var META_KEY = 'cfl_meta';
  function loadMeta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch (e) { return {}; }
  }
  function saveMeta() {
    try { localStorage.setItem(META_KEY, JSON.stringify(meta)); } catch (e) { console.error(e); }
  }
  var meta = loadMeta();

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  if (!meta.device_id) { meta.device_id = uuid(); saveMeta(); }

  // Local, monotonic write order (internal field, not exported).
  function nextLocalSeq() {
    meta.seq = (meta.seq || 0) + 1;
    saveMeta();
    return meta.seq;
  }

  // ---------------------------------------------------------------- time (APP_SPEC §3)
  function offsetMs() {
    var m = /^([+-])(\d\d):(\d\d)$/.exec(CFG.TZ_OFFSET);
    var v = (+m[2] * 60 + +m[3]) * 60000;
    return m[1] === '-' ? -v : v;
  }
  function isoLocal(ms) {
    return new Date(ms + offsetMs()).toISOString().replace('Z', CFG.TZ_OFFSET);
  }
  function clockLocal(ms) { return isoLocal(ms).slice(11, 19); }
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var ss = (s < 10 ? '0' : '') + s;
    if (h) return h + ':' + (m < 10 ? '0' : '') + m + ':' + ss;
    return m + ':' + ss;
  }

  // ---------------------------------------------------------------- state
  var S = null; // current session state, rebuilt from events
  var ui = { picking: null, pickMs: 0, snapshot: null, confirmEnd: false, error: '' };

  function freshState(cfg) {
    return {
      cfg: cfg, events: [], customers: {}, order: [], nextSeq: 1,
      startMs: cfg.start_ms, ended: false, endMs: 0,
      lastEndMs: -Infinity, savedSlot: 0, lastSnap: null, arrivalById: {}
    };
  }

  function apply(e) {
    var ms = e._ms;
    var c = e.customer_seq !== '' ? S.customers[e.customer_seq] : null;
    switch (e.event_type) {
      case 'session_start': S.startMs = ms; break;
      case 'session_end': S.ended = true; S.endMs = ms; break;
      case 'arrival':
        c = { seq: e.customer_seq, arrivalId: e.event_id, arrivalMs: ms, startMs: 0, endMs: 0,
          employee: '', order: '', items: 0, x: 0, closed: '' };
        S.customers[c.seq] = c;
        S.order.push(c.seq);
        S.arrivalById[e.event_id] = c;
        S.nextSeq = Math.max(S.nextSeq, c.seq + 1);
        break;
      case 'service_start': if (c) { c.startMs = ms; c.employee = e.employee; } break;
      case 'service_end':
        if (c) { c.endMs = ms; c.closed = 'end'; }
        S.lastEndMs = Math.max(S.lastEndMs, ms);
        break;
      case 'balk': case 'renege': if (c) c.closed = e.event_type; break;
      case 'interruption': if (c) c.x += 1; break;
      case 'edit':
        var t = S.arrivalById[e.target_event_id];
        if (t) {
          if (e.order_type !== '') t.order = e.order_type;
          if (e.items !== '') t.items = e.items;
        }
        break;
      case 'snapshot':
        S.savedSlot = Math.max(S.savedSlot, Math.floor(e.elapsed_s / CFG.SNAPSHOT_INTERVAL_S));
        S.lastSnap = e;
        break;
    }
  }

  function makeEvent(type, f, ms) {
    var cfg = S.cfg;
    var e = {};
    COLS.forEach(function (k) { e[k] = ''; });
    for (var k in f) if (f.hasOwnProperty(k)) e[k] = f[k];
    e.event_id = uuid();
    e.session_id = cfg.session_id;
    e.observer = cfg.observer;
    e.station = cfg.station;
    e.device_id = meta.device_id;
    e.event_type = type;
    e.timestamp = isoLocal(ms);
    e.elapsed_s = Math.round((ms - S.startMs) / 100) / 10;
    e.app_version = CFG.APP_VERSION;
    e._ms = ms;          // internal
    e._seq = nextLocalSeq(); // internal
    e.synced = 0;        // internal; set by Session 2's sync queue
    return e;
  }

  // Serialised write queue: store first, then state + UI.
  var writeQueue = Promise.resolve();
  function log(type, fields, ms) {
    var e = makeEvent(type, fields || {}, ms || Date.now());
    var p = writeQueue.then(function () {
      return DB.put(e).then(function () {
        S.events.push(e);
        apply(e);
        render();
        return e;
      }, function (err) {
        console.error('EVENT NOT SAVED', err, e);
        ui.error = 'Could not save on this phone. Use paper now.';
        render();
        throw err;
      });
    });
    writeQueue = p.catch(function () {});
    return p;
  }

  // ---------------------------------------------------------------- derived
  function openCustomers() {
    var d = currentDismissed();
    return S.order.map(function (s) { return S.customers[s]; })
      .filter(function (c) { return !c.closed && !d[c.seq]; });
  }
  function currentDismissed() {
    var map = {};
    ((meta.current && meta.current.dismissed) || []).forEach(function (s) { map[s] = true; });
    return map;
  }
  // APP_SPEC §4.2: first customer who arrived after the observer's last completed service.
  function nextToTime() {
    var d = currentDismissed();
    for (var i = 0; i < S.order.length; i++) {
      var c = S.customers[S.order[i]];
      if (c.arrivalMs <= S.lastEndMs) continue;
      if (c.closed === 'balk' || c.closed === 'renege' || d[c.seq]) continue;
      return c.closed ? null : c.seq;
    }
    return null;
  }
  function elapsedS() { return (Date.now() - S.startMs) / 1000; }
  function dueSlot() { return Math.floor(elapsedS() / CFG.SNAPSHOT_INTERVAL_S); }
  function snapshotDue() { return !S.ended && dueSlot() >= 1 && dueSlot() > S.savedSlot; }
  function counts() {
    var n = S.events.length, synced = 0;
    S.events.forEach(function (e) { if (e.synced) synced++; });
    return { saved: n, synced: synced, pending: n - synced };
  }

  // ---------------------------------------------------------------- rendering
  var app = document.getElementById('app');
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }
  function btn(label, action, opts) {
    opts = opts || {};
    var attrs = ' data-action="' + action + '"';
    if (opts.arg !== undefined) attrs += ' data-arg="' + esc(opts.arg) + '"';
    if (opts.disabled) attrs += ' disabled';
    return '<button type="button" class="btn ' + (opts.cls || '') + '"' + attrs + '>' + label +
      (opts.sub ? '<span class="sub">' + esc(opts.sub) + '</span>' : '') + '</button>';
  }

  function statusBar() {
    var c = counts();
    var online = navigator.onLine;
    var dotCls = !online ? 'bad' : (c.pending ? 'pending' : 'ok');
    return '<div class="status">' +
      '<span class="dot ' + dotCls + '" id="dot" aria-label="' + (online ? 'online' : 'offline') + '"></span>' +
      '<span class="stat"><span class="k">Saved on phone</span><span class="v tnum" id="st-saved">' + c.saved + '</span></span>' +
      '<span class="stat"><span class="k">Synced</span><span class="v tnum">' + c.synced + '</span></span>' +
      '<span class="stat"><span class="k">Pending</span><span class="v tnum">' + c.pending + '</span></span>' +
      '<span class="elapsed tnum" id="elapsed">' + fmtDur(S.ended ? (S.endMs - S.startMs) / 1000 : elapsedS()) + '</span>' +
      '</div>';
  }

  function render() {
    if (!S) return renderSetup();
    if (S.ended) return renderSummary();
    renderCounter();
  }

  // ---- setup (APP_SPEC §4.1)
  var draft = null;
  function renderSetup() {
    if (!draft) {
      var last = meta.lastSetup || {};
      draft = {
        observer: meta.observer || '',
        station: '',
        employees: (last.employees && last.employees.length ? last.employees : [
          { code: 'E1', desc: '' }, { code: 'E2', desc: '' }, { code: 'E3', desc: '' }])
          .map(function (x) { return { code: x.code, desc: x.desc }; })
      };
    }
    var h = '';
    h += '<div class="band"><span class="title">COZMO FIELD LOGGER</span><span class="label">v' + esc(CFG.APP_VERSION) + '</span></div>';
    h += '<div class="scroll">';
    h += '<div class="section"><label class="label" for="in-observer">Observer name</label>' +
      '<input type="text" id="in-observer" autocomplete="off" autocorrect="off" spellcheck="false" value="' + esc(draft.observer) + '"></div>';
    h += '<div class="section"><span class="label">Station</span><div class="stack">';
    STATIONS.forEach(function (st) {
      var built = BUILT_MODES[st.mode];
      h += btn(esc(st.name), 'pick-station', {
        arg: st.name,
        cls: draft.station === st.name ? 'on' : '',
        disabled: !built,
        sub: built ? '' : 'Not built yet (Session 2)'
      });
    });
    h += '</div></div>';
    h += '<div class="section"><span class="label">Counter employees — one-line description</span><div class="stack">';
    draft.employees.forEach(function (emp, i) {
      h += '<div class="row" style="align-items:center"><span class="cnum" style="flex:0 0 56px;font-size:24px">' + esc(emp.code) + '</span>' +
        '<input type="text" data-emp="' + i + '" autocomplete="off" placeholder="e.g. red cap, left scale" value="' + esc(emp.desc) + '"></div>';
    });
    if (draft.employees.length < 4) h += btn('+ Add E4', 'add-e4');
    else h += btn('Remove E4', 'remove-e4');
    h += '</div></div>';
    if (ui.error) h += '<div class="err">' + esc(ui.error) + '</div>';
    h += '</div>';
    var ready = draft.observer.trim() && draft.station;
    h += '<div class="actionbar"><button type="button" class="primary" data-action="start-session"' + (ready ? '' : ' disabled') + '>START SESSION' +
      '<span class="sub">' + (ready ? esc(draft.station) : (draft.observer.trim() ? 'Pick a station' : 'Enter observer name')) + '</span></button></div>';
    app.innerHTML = h;
  }

  // ---- counter mode (APP_SPEC §4.2)
  function cardHtml(c, nextSeq) {
    var started = !!c.startMs;
    var isNext = c.seq === nextSeq;
    var h = '<section class="card' + (isNext ? ' next' : '') + '" data-seq="' + c.seq + '">';
    h += '<div class="card-head"><span class="cnum tnum">#' + c.seq + '</span>';
    if (isNext) h += '<span class="tag">NEXT</span>';
    if (started) h += '<span class="emp">' + esc(c.employee) + '</span>';
    h += '<span class="timer"><span class="label">' + (started ? 'Service' : 'Wait') + '</span>' +
      '<span class="t tnum" data-since="' + (started ? c.startMs : c.arrivalMs) + '">' +
      fmtDur((Date.now() - (started ? c.startMs : c.arrivalMs)) / 1000) + '</span></span></div>';

    if (!started && ui.picking === c.seq) {
      h += '<div class="row">';
      S.cfg.employees.forEach(function (emp) {
        h += btn(esc(emp.code), 'pick-emp', { arg: emp.code, cls: 'fill', sub: emp.desc });
      });
      h += btn('Back', 'cancel-pick');
      h += '</div>';
    } else if (!started) {
      h += '<div class="row">' +
        btn('Start', 'start', { arg: c.seq, cls: 'fill wide' }) +
        btn('Balk', 'balk', { arg: c.seq }) +
        btn('Renege', 'renege', { arg: c.seq }) +
        btn('Not<br>timed', 'dismiss', { arg: c.seq }) +
        '</div>';
    } else {
      h += '<div class="row">' + btn('End', 'end', { arg: c.seq, cls: 'fill wide' }) +
        btn('X <span class="tnum">' + c.x + '</span>', 'interrupt', { arg: c.seq, sub: 'interrupt' }) + '</div>';
      h += '<div class="row">';
      ORDER_TYPES.forEach(function (o) {
        h += btn(o, 'order', { arg: c.seq + ':' + o, cls: c.order === o ? 'on' : '' });
      });
      h += '</div>';
      h += '<div class="row">' + btn('−', 'items-dec', { arg: c.seq, disabled: c.items <= 0 }) +
        '<span class="stepval tnum">' + c.items + '</span>' +
        btn('+', 'items-inc', { arg: c.seq }) +
        '<span class="label" style="align-self:center;flex:1.2">Items</span></div>';
    }
    h += '</section>';
    return h;
  }

  function renderCounter() {
    var open = openCustomers();
    var nextSeq = nextToTime();
    var h = statusBar();
    var due = snapshotDue();
    h += '<div class="band"><span class="title">' + esc(S.cfg.station) + ' · ' + esc(S.cfg.observer) + '</span>' +
      btn('Snapshot', 'snapshot-open', { cls: 'slim' + (due ? ' amber' : ''), sub: due ? 'due' : '' }) +
      btn('End', 'end-session-ask', { cls: 'slim' }) + '</div>';
    if (ui.error) h += '<div class="err">' + esc(ui.error) + '</div>';
    h += '<div class="scroll" id="cards">';
    if (!open.length) h += '<div class="empty">No open customers. Tap ARRIVAL when a customer joins the counter.</div>';
    open.forEach(function (c) { h += cardHtml(c, nextSeq); });
    h += '</div>';
    h += '<div class="actionbar"><button type="button" class="primary" data-action="arrival">ARRIVAL' +
      '<span class="sub">Customer #' + S.nextSeq + '</span></button></div>';
    if (ui.snapshot) h += snapshotHtml();
    if (ui.confirmEnd) h += confirmEndHtml();
    var sc = document.getElementById('cards');
    var top = sc ? sc.scrollTop : 0;
    app.innerHTML = h;
    var sc2 = document.getElementById('cards');
    if (sc2) sc2.scrollTop = top;
  }

  // ---- snapshot (APP_SPEC §4.5) — counter stations: queue, serving, idle.
  function snapshotHtml() {
    var v = ui.snapshot;
    function stepper(label, key) {
      return '<div class="stepper"><span class="label">' + label + '</span><div class="row">' +
        btn('−', 'snap-dec', { arg: key, disabled: v[key] <= 0 }) +
        '<span class="stepval tnum">' + v[key] + '</span>' +
        btn('+', 'snap-inc', { arg: key }) + '</div></div>';
    }
    var h = '<div class="overlay" role="dialog" aria-label="Snapshot">';
    h += '<div class="alarm">SNAPSHOT<span class="sub tnum">' +
      (v.scheduled ? 'Due at ' + fmtDur(v.slot * CFG.SNAPSHOT_INTERVAL_S) + ' — count now' : 'Manual snapshot') + '</span></div>';
    h += '<div class="body">';
    h += stepper('Queue length (waiting, not being served)', 'queue');
    h += stepper('Employees serving', 'serving');
    h += stepper('Employees present, not serving', 'idle');
    h += '</div>';
    h += '<div class="foot"><div class="row">' + btn('Close', 'snap-close', { cls: 'slim' }) +
      btn('Save', 'snap-save', { cls: 'fill wide' }) + '</div></div>';
    h += '</div>';
    return h;
  }
  function openSnapshot(scheduled) {
    var last = S.lastSnap;
    ui.snapshot = {
      scheduled: scheduled, slot: dueSlot(),
      queue: 0,
      serving: last ? +last.employees_serving || 0 : 0,
      idle: last ? +last.employees_idle || 0 : 0
    };
    ui.confirmEnd = false;
    render();
  }

  // ---- end session (APP_SPEC §4.7)
  function confirmEndHtml() {
    return '<div class="overlay" role="dialog" aria-label="End session">' +
      '<div class="head">End session?</div>' +
      '<div class="body"><p>Open customer cards stay as they are in the log. You can export the CSV on the next screen.</p></div>' +
      '<div class="foot"><div class="row">' + btn('Cancel', 'end-session-cancel') +
      btn('End session', 'end-session-confirm', { cls: 'fill' }) + '</div></div></div>';
  }

  function renderSummary() {
    var byType = {};
    S.events.forEach(function (e) { byType[e.event_type] = (byType[e.event_type] || 0) + 1; });
    var c = counts();
    var h = statusBar();
    h += '<div class="band"><span class="title">SESSION ENDED · ' + esc(S.cfg.station) + '</span></div>';
    h += '<div class="scroll">';
    h += '<div class="section"><span class="label">Events by type</span></div>';
    ['session_start', 'arrival', 'service_start', 'service_end', 'balk', 'renege', 'interruption',
      'edit', 'snapshot', 'session_end'].forEach(function (t) {
      h += '<div class="kv"><span>' + t + '</span><b class="tnum">' + (byType[t] || 0) + '</b></div>';
    });
    h += '<div class="section"><span class="label">Sync status</span></div>';
    h += '<div class="kv"><span>Saved on phone</span><b class="tnum">' + c.saved + '</b></div>';
    h += '<div class="kv"><span>Synced</span><b class="tnum">' + c.synced + '</b></div>';
    h += '<div class="kv"><span>Pending</span><b class="tnum">' + c.pending + '</b></div>';
    if (!CFG.APPS_SCRIPT_URL) h += '<div class="note">Sync to the Sheet is not set up in this version. Export the CSV now and keep it.</div>';
    if (ui.error) h += '<div class="err">' + esc(ui.error) + '</div>';
    h += '<div class="section stack">' + btn('New session', 'new-session') + '</div>';
    h += '</div>';
    h += '<div class="actionbar"><button type="button" class="primary" data-action="export">EXPORT CSV' +
      '<span class="sub">' + c.saved + ' events · share sheet</span></button></div>';
    app.innerHTML = h;
  }

  // ---------------------------------------------------------------- CSV export (APP_SPEC §2.5)
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function buildCsv(events) {
    var lines = [COLS.join(',')];
    events.forEach(function (e) { lines.push(COLS.map(function (k) { return csvCell(e[k]); }).join(',')); });
    return lines.join('\r\n') + '\r\n';
  }
  function exportCsv() {
    // Built synchronously from memory so the share sheet keeps the tap's user activation.
    var csv = buildCsv(S.events);
    var stamp = isoLocal(S.startMs).slice(0, 16).replace(/[-:]/g, '').replace('T', '_');
    var name = 'cozmo_' + S.cfg.station.toLowerCase().replace(/\s+/g, '-') + '_' + stamp + '_' +
      S.cfg.session_id.slice(0, 8) + '.csv';
    var file = null;
    try { file = new File([csv], name, { type: 'text/csv' }); } catch (e) { file = null; }
    if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: name }).catch(function (err) {
        if (err && err.name === 'AbortError') return;
        console.warn('share failed, downloading', err);
        download(csv, name);
      });
    } else {
      download(csv, name);
    }
  }
  function download(csv, name) {
    var url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  // ---------------------------------------------------------------- actions
  function cust(arg) { return S.customers[+arg]; }

  var actions = {
    'pick-station': function (arg) { draft.station = arg; render(); },
    'add-e4': function () { draft.employees.push({ code: 'E4', desc: '' }); render(); },
    'remove-e4': function () { draft.employees = draft.employees.slice(0, 3); render(); },
    'start-session': function () {
      var observer = draft.observer.trim();
      if (!observer || !draft.station) return;
      var now = Date.now();
      var cfg = {
        session_id: uuid(), observer: observer, station: draft.station, start_ms: now,
        employees: draft.employees.map(function (x) { return { code: x.code, desc: x.desc.trim() }; }),
        dismissed: [], closedSlot: 0
      };
      meta.observer = observer;
      meta.lastSetup = { employees: cfg.employees };
      meta.current = cfg;
      saveMeta();
      S = freshState(cfg);
      ui.error = '';
      // Employee descriptions travel in the session_start note (no other column fits).
      var note = cfg.employees.map(function (x) { return x.code + ': ' + x.desc; }).join(' | ');
      log('session_start', { note: note }, now);
    },
    'arrival': function () { log('arrival', { customer_seq: S.nextSeq }); },
    'start': function (arg) { ui.picking = +arg; ui.pickMs = Date.now(); render(); },
    'cancel-pick': function () { ui.picking = null; render(); },
    'pick-emp': function (arg) {
      var seq = ui.picking;
      var c = S.customers[seq];
      if (!c || c.startMs || c.closed) { ui.picking = null; render(); return; }
      ui.picking = null;
      // Timestamp is the START tap, not the employee tap.
      log('service_start', { customer_seq: seq, employee: arg }, ui.pickMs);
    },
    'end': function (arg) {
      var c = cust(arg);
      if (c && c.startMs && !c.closed) log('service_end', { customer_seq: c.seq, employee: c.employee });
    },
    'balk': function (arg) { var c = cust(arg); if (c && !c.startMs && !c.closed) log('balk', { customer_seq: c.seq }); },
    'renege': function (arg) { var c = cust(arg); if (c && !c.startMs && !c.closed) log('renege', { customer_seq: c.seq }); },
    'dismiss': function (arg) {
      // APP_SPEC §4.2: an arrival-only card may be dismissed as "not timed".
      // No event type exists for this; the arrival event alone already means "not timed".
      var c = cust(arg);
      if (!c || c.startMs) return;
      meta.current.dismissed = (meta.current.dismissed || []).concat([c.seq]);
      saveMeta();
      render();
    },
    'interrupt': function (arg) {
      var c = cust(arg);
      if (c && !c.closed) log('interruption', { customer_seq: c.seq, employee: c.employee });
    },
    'order': function (arg) {
      var p = arg.split(':'), c = cust(p[0]);
      if (c && !c.closed && c.order !== p[1]) log('edit', { customer_seq: c.seq, target_event_id: c.arrivalId, order_type: p[1] });
    },
    'items-inc': function (arg) {
      var c = cust(arg);
      if (c && !c.closed) log('edit', { customer_seq: c.seq, target_event_id: c.arrivalId, items: c.items + 1 });
    },
    'items-dec': function (arg) {
      var c = cust(arg);
      if (c && !c.closed && c.items > 0) log('edit', { customer_seq: c.seq, target_event_id: c.arrivalId, items: c.items - 1 });
    },
    'snapshot-open': function () { openSnapshot(snapshotDue()); },
    'snap-inc': function (k) { ui.snapshot[k] += 1; render(); },
    'snap-dec': function (k) { if (ui.snapshot[k] > 0) ui.snapshot[k] -= 1; render(); },
    'snap-close': function () {
      if (ui.snapshot.scheduled) { meta.current.closedSlot = ui.snapshot.slot; saveMeta(); }
      ui.snapshot = null; render();
    },
    'snap-save': function () {
      var v = ui.snapshot;
      ui.snapshot = null;
      log('snapshot', { queue_len: String(v.queue), employees_serving: v.serving, employees_idle: v.idle });
    },
    'end-session-ask': function () { ui.confirmEnd = true; ui.picking = null; render(); },
    'end-session-cancel': function () { ui.confirmEnd = false; render(); },
    'end-session-confirm': function () { ui.confirmEnd = false; log('session_end', {}); },
    'export': function () { exportCsv(); },
    'new-session': function () {
      meta.current = null; saveMeta();
      S = null; draft = null; ui = { picking: null, pickMs: 0, snapshot: null, confirmEnd: false, error: '' };
      render();
    }
  };

  // Tap feedback: invert colours for 150 ms (APP_SPEC §8a).
  app.addEventListener('pointerdown', function (ev) {
    var b = ev.target.closest('button');
    if (!b || b.disabled) return;
    b.classList.add('inv');
    setTimeout(function () { b.classList.remove('inv'); }, 150);
  });
  app.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-action]');
    if (!b || b.disabled) return;
    var fn = actions[b.getAttribute('data-action')];
    if (fn) fn(b.getAttribute('data-arg'));
  });
  app.addEventListener('input', function (ev) {
    if (!draft) return;
    var t = ev.target;
    var hadName = !!draft.observer.trim();
    if (t.id === 'in-observer') {
      draft.observer = t.value;
      if (hadName !== !!t.value.trim()) updateStartButton();
    } else if (t.hasAttribute('data-emp')) {
      draft.employees[+t.getAttribute('data-emp')].desc = t.value;
    }
  });
  function updateStartButton() {
    var b = app.querySelector('[data-action="start-session"]');
    if (!b) return;
    var ready = draft.observer.trim() && draft.station;
    b.disabled = !ready;
    b.querySelector('.sub').textContent = ready ? draft.station : (draft.observer.trim() ? 'Pick a station' : 'Enter observer name');
  }

  // ---------------------------------------------------------------- clock tick
  function tick() {
    if (!S || S.ended) return;
    var el = document.getElementById('elapsed');
    if (el) el.textContent = fmtDur(elapsedS());
    var now = Date.now();
    var ts = app.querySelectorAll('[data-since]');
    for (var i = 0; i < ts.length; i++) ts[i].textContent = fmtDur((now - +ts[i].getAttribute('data-since')) / 1000);
    var due = snapshotDue();
    var snapBtn = app.querySelector('[data-action="snapshot-open"]');
    if (snapBtn && due !== snapBtn.classList.contains('amber')) render();
    if (due && !ui.snapshot && !ui.confirmEnd && dueSlot() > (meta.current.closedSlot || 0)) openSnapshot(true);
  }
  setInterval(tick, 500);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
  window.addEventListener('online', function () { if (S) render(); });
  window.addEventListener('offline', function () { if (S) render(); });

  // ---------------------------------------------------------------- boot
  function boot() {
    DB.migrateFallback().then(function () {
      var cur = meta.current;
      if (!cur || !cur.session_id) { render(); return; }
      return DB.bySession(cur.session_id).then(function (events) {
        S = freshState(cur);
        events.forEach(function (e) { S.events.push(e); apply(e); });
        if (!events.length) {
          // session_start never reached storage: log it now rather than lose the session.
          return log('session_start', { note: cur.employees.map(function (x) { return x.code + ': ' + x.desc; }).join(' | ') }, cur.start_ms);
        }
        render();
        tick();
      });
    }).catch(function (err) {
      console.error(err);
      ui.error = 'Storage error: ' + (err && err.message);
      render();
    });
  }

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(function () {});
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (err) { console.warn('SW registration failed', err); });
    });
  }

  window.CFL_TEST = { buildCsv: buildCsv, isoLocal: isoLocal, COLS: COLS, state: function () { return S; } };
  boot();
})();
