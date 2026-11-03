// Cozmo Field Logger — v0.2.0.
// Session 1: setup, counter mode, snapshots, CSV export, offline app shell.
// Session 2: undo + edit a time (§4.6), checkout service (§4.3), checkout
// arrivals (§4.4), per-lane snapshots (§4.5), wake lock (§8), app updates.
//
// Every tap that records data writes one event to the store BEFORE the UI
// changes (APP_SPEC §2.1). The event log is append-only. Screen state is
// always rebuilt by replaying the whole log (undo and edit events included),
// so a force-quit loses nothing and corrections can never drift from the log.
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
    { name: 'Checkout service', mode: 'checkout-service' },
    { name: 'Checkout arrivals', mode: 'checkout-arrivals' }
  ];
  var ORDER_TYPES = ['S', 'W', 'P', 'M'];
  var BASKETS = [['H', 'hand'], ['B', 'basket'], ['T', 'trolley']];
  var PAYS = [['C', 'cash'], ['K', 'card']];
  var LANE_CHOICES = 16;           // lane numbers offered on setup / lane toggles
  var BIN_MS = 5 * 60 * 1000;      // §4.4 live count bin, aligned to the wall clock
  var UNDOABLE = { arrival: 1, join: 1, service_start: 1, service_end: 1, balk: 1, renege: 1,
    interruption: 1, edit: 1, snapshot: 1, lane_open: 1, lane_close: 1 };
  var TIME_EDITABLE = { arrival: 1, join: 1, service_start: 1, service_end: 1, balk: 1, renege: 1,
    lane_open: 1, lane_close: 1 };

  function modeOf(station) {
    for (var i = 0; i < STATIONS.length; i++) if (STATIONS[i].name === station) return STATIONS[i].mode;
    return 'counter';
  }
  function laneSort(a, b) { return (+a) - (+b); }
  function laneLabel(l) { return l === 'other' ? 'Other' : 'L' + l; }

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
  function binOf(ms) {
    var off = offsetMs();
    var start = Math.floor((ms + off) / BIN_MS) * BIN_MS - off;
    return { start: start, end: start + BIN_MS };
  }

  // ---------------------------------------------------------------- state
  var S = null; // current session state, rebuilt from events
  function freshUi() {
    return { picking: null, pickMs: 0, snapshot: null, confirmEnd: false, error: '',
      edit: null, lanes: false, toast: '', wakeTip: false, lastBin: 0 };
  }
  var ui = freshUi();

  function freshState(cfg) {
    var st = { cfg: cfg, mode: modeOf(cfg.station), events: [], pendingUndo: {} };
    return st;
  }

  function resetDerived() {
    S.startMs = S.cfg.start_ms;
    S.ended = false; S.endMs = 0;
    S.customers = {}; S.order = []; S.custByEvent = {}; S.byId = {};
    S.lastEndMs = -Infinity; S.savedSlot = 0; S.lastSnap = null;
    S.joins = []; S.openLanes = {};
    S.undone = {}; S.effMs = {}; S.live = [];
    S.nextSeq = 1;
  }

  function baseMs(e) { return typeof e._ms === 'number' ? e._ms : Date.parse(e.timestamp); }

  // Replay the whole log. Undone events are skipped; edited times replace the
  // original time. Customer numbers are never reused, even after an undo.
  function rebuild() {
    resetDerived();
    var newMs = {}, maxSeq = 0;
    S.events.forEach(function (e) {
      S.byId[e.event_id] = e;
      if (e.event_type === 'undo') S.undone[e.target_event_id] = true;
      if (e.customer_seq !== '' && +e.customer_seq > maxSeq) maxSeq = +e.customer_seq;
    });
    S.events.forEach(function (e) {
      if (e.event_type === 'edit' && e.new_timestamp && !S.undone[e.event_id]) {
        var t = Date.parse(e.new_timestamp);
        if (!isNaN(t)) newMs[e.target_event_id] = t;
      }
    });
    S.nextSeq = maxSeq + 1;
    S.events.forEach(function (e) {
      if (e.event_type === 'undo' || S.undone[e.event_id]) return;
      var ms = newMs.hasOwnProperty(e.event_id) ? newMs[e.event_id] : baseMs(e);
      S.effMs[e.event_id] = ms;
      S.live.push(e);
      apply(e, ms);
    });
  }

  function apply(e, ms) {
    var c = e.customer_seq !== '' ? S.customers[e.customer_seq] : null;
    switch (e.event_type) {
      case 'session_start': S.startMs = ms; break;
      case 'session_end': S.ended = true; S.endMs = ms; break;
      case 'arrival': case 'join':
        if (e.customer_seq === '') { S.joins.push({ id: e.event_id, lane: e.lane, ms: ms }); break; }
        c = { seq: +e.customer_seq, lane: e.lane || '', arrivalId: e.event_id, arrivalMs: ms,
          startId: '', startMs: 0, endMs: 0, employee: '', order: '', items: 0, basket: '', pay: '',
          x: 0, closed: '' };
        S.customers[c.seq] = c;
        S.order.push(c.seq);
        S.custByEvent[e.event_id] = c;
        break;
      case 'service_start': if (c) { c.startMs = ms; c.startId = e.event_id; c.employee = e.employee; } break;
      case 'service_end':
        if (c) { c.endMs = ms; c.closed = 'end'; }
        S.lastEndMs = Math.max(S.lastEndMs, ms);
        break;
      case 'balk': case 'renege': if (c) c.closed = e.event_type; break;
      case 'interruption': if (c) c.x += 1; break;
      case 'edit':
        if (e.new_timestamp) break; // time edits are applied in rebuild()
        var t = S.custByEvent[e.target_event_id];
        if (t) {
          if (e.order_type !== '') t.order = e.order_type;
          if (e.items !== '') t.items = +e.items;
          if (e.basket !== '') t.basket = e.basket;
          if (e.pay !== '') t.pay = e.pay;
        }
        break;
      case 'snapshot':
        S.savedSlot = Math.max(S.savedSlot, Math.floor(e.elapsed_s / CFG.SNAPSHOT_INTERVAL_S));
        S.lastSnap = e;
        break;
      case 'lane_open': S.openLanes[e.lane] = true; break;
      case 'lane_close': delete S.openLanes[e.lane]; break;
    }
  }

  function makeEvent(type, f, ms) {
    var cfg = S.cfg;
    var e = {};
    COLS.forEach(function (k) { e[k] = ''; });
    for (var k in f) if (f.hasOwnProperty(k) && f[k] !== undefined && f[k] !== null) e[k] = f[k];
    e.event_id = uuid();
    e.session_id = cfg.session_id;
    e.observer = cfg.observer;
    e.station = cfg.station;
    e.device_id = meta.device_id;
    e.event_type = type;
    e.timestamp = isoLocal(ms);
    e.elapsed_s = Math.round((ms - S.startMs) / 100) / 10;
    e.app_version = CFG.APP_VERSION;
    e._ms = ms;              // internal
    e._seq = nextLocalSeq(); // internal
    e.synced = 0;            // internal; set by the sync queue (not built yet)
    return e;
  }

  // Serialised write queue: store first, then state + UI.
  var writeQueue = Promise.resolve();
  function log(type, fields, ms) {
    var e = makeEvent(type, fields || {}, ms || Date.now());
    var p = writeQueue.then(function () {
      return DB.put(e).then(function () {
        S.events.push(e);
        rebuild();
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
  function currentDismissed() {
    var map = {};
    ((meta.current && meta.current.dismissed) || []).forEach(function (s) { map[s] = true; });
    return map;
  }
  function openCustomers() {
    var d = currentDismissed();
    return S.order.map(function (s) { return S.customers[s]; })
      .filter(function (c) { return !c.closed && !d[c.seq]; });
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
  function openLaneList() { return Object.keys(S.openLanes).sort(laneSort); }
  function elapsedS() { return (Date.now() - S.startMs) / 1000; }
  function dueSlot() { return Math.floor(elapsedS() / CFG.SNAPSHOT_INTERVAL_S); }
  function snapshotDue() { return !S.ended && dueSlot() >= 1 && dueSlot() > S.savedSlot; }
  function counts() {
    var n = S.events.length, synced = 0;
    S.events.forEach(function (e) { if (e.synced) synced++; });
    return { saved: n, synced: synced, pending: n - synced };
  }

  // Undo = the most recent event that is undoable and not already undone.
  function undoTarget() {
    for (var i = S.events.length - 1; i >= 0; i--) {
      var e = S.events[i];
      if (UNDOABLE[e.event_type] && !S.undone[e.event_id] && !S.pendingUndo[e.event_id]) return e;
    }
    return null;
  }

  function describe(e) {
    var who = e.customer_seq !== '' ? '#' + e.customer_seq : '';
    switch (e.event_type) {
      case 'arrival': return who + ' arrival';
      case 'join': return who ? who + ' join ' + laneLabel(e.lane) : 'join ' + laneLabel(e.lane);
      case 'service_start': return who + ' start';
      case 'service_end': return who + ' end';
      case 'balk': return who + ' balk';
      case 'renege': return who + ' renege';
      case 'interruption': return who + ' X';
      case 'snapshot': return 'snapshot';
      case 'lane_open': return 'open ' + laneLabel(e.lane);
      case 'lane_close': return 'close ' + laneLabel(e.lane);
      case 'edit':
        if (e.new_timestamp) {
          var tgt = S.byId[e.target_event_id];
          return (tgt ? describe(tgt) : who) + ' time';
        }
        if (e.order_type !== '') return who + ' order ' + e.order_type;
        if (e.items !== '') return who + ' items ' + e.items;
        if (e.basket !== '') return who + ' basket ' + e.basket;
        if (e.pay !== '') return who + ' pay ' + e.pay;
        return who + ' edit';
    }
    return e.event_type;
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

  // Undo · Edit time · Snapshot · End — same on every station.
  function toolsBand() {
    var t = undoTarget();
    var due = snapshotDue();
    return '<div class="band tools">' +
      btn('Undo', 'undo', { cls: 'undo', disabled: !t, sub: t ? describe(t) : 'nothing' }) +
      btn('Edit<br>time', 'edit-open') +
      btn('Snapshot' + (due ? '<span class="badge">DUE</span>' : ''), 'snapshot-open', { cls: 'snap' + (due ? ' amber' : '') }) +
      btn('End', 'end-session-ask', { cls: 'endb' }) +
      '</div>';
  }

  function wakeTipHtml() {
    if (!ui.wakeTip || meta.wakeTipDismissed) return '';
    return '<div class="tip"><span>Screen may auto-lock on this phone. Set <b>Settings → Display &amp; Brightness → Auto-Lock → Never</b> for the session.</span>' +
      btn('OK', 'wake-tip-ok', { cls: 'slim' }) + '</div>';
  }

  function overlays() {
    var h = '';
    if (ui.lanes) h += lanesHtml();
    if (ui.edit) h += editHtml();
    if (ui.confirmEnd) h += confirmEndHtml();
    if (ui.snapshot) h += snapshotHtml();
    if (ui.toast) h += '<div class="toast" role="status">' + esc(ui.toast) + '</div>';
    return h;
  }

  function paint(h) {
    var sc = document.getElementById('cards');
    var top = sc ? sc.scrollTop : 0;
    app.innerHTML = h;
    var sc2 = document.getElementById('cards');
    if (sc2) sc2.scrollTop = top;
  }

  function render() {
    if (!S) return renderSetup();
    if (S.ended) return renderSummary();
    if (S.mode === 'checkout-service') return renderService();
    if (S.mode === 'checkout-arrivals') return renderArrivals();
    renderCounter();
  }

  // ---- setup (APP_SPEC §4.1)
  var draft = null;
  function setupReady() {
    if (!draft.observer.trim()) return 'Enter observer name';
    if (!draft.station) return 'Pick a station';
    var mode = modeOf(draft.station);
    if (mode === 'checkout-service' && draft.lanesService.length !== 2) return 'Pick the 2 lanes you watch';
    if (mode === 'checkout-arrivals' && !draft.lanesOpen.length) return 'Pick the open lanes';
    return '';
  }
  function lanePicker(list) {
    var h = '<div class="lanepick">';
    for (var n = 1; n <= LANE_CHOICES; n++) {
      h += btn(String(n), 'setup-lane', { arg: n, cls: list.indexOf(String(n)) >= 0 ? 'on' : '' });
    }
    return h + '</div>';
  }
  function renderSetup() {
    if (!draft) {
      var last = meta.lastSetup || {};
      draft = {
        observer: meta.observer || '',
        station: '',
        employees: (last.employees && last.employees.length ? last.employees : [
          { code: 'E1', desc: '' }, { code: 'E2', desc: '' }, { code: 'E3', desc: '' }])
          .map(function (x) { return { code: x.code, desc: x.desc }; }),
        lanesService: (last.lanesService || []).slice(),
        lanesOpen: (last.lanesOpen || []).slice()
      };
    }
    var mode = draft.station ? modeOf(draft.station) : '';
    var h = '';
    h += '<div class="band"><span class="title">COZMO FIELD LOGGER</span><span class="ver tnum" id="app-version">v' + esc(CFG.APP_VERSION) + '</span></div>';
    h += '<div class="scroll">';
    h += '<div class="section"><label class="label" for="in-observer">Observer name</label>' +
      '<input type="text" id="in-observer" autocomplete="off" autocorrect="off" spellcheck="false" value="' + esc(draft.observer) + '"></div>';
    h += '<div class="section"><span class="label">Station</span><div class="stack">';
    STATIONS.forEach(function (st) {
      h += btn(esc(st.name), 'pick-station', { arg: st.name, cls: draft.station === st.name ? 'on' : '' });
    });
    h += '</div></div>';
    if (mode === 'counter') {
      h += '<div class="section"><span class="label">Counter employees — appearance or position, not a name</span><div class="stack">';
      draft.employees.forEach(function (emp, i) {
        h += '<div class="row" style="align-items:center"><span class="cnum" style="flex:0 0 56px;font-size:24px">' + esc(emp.code) + '</span>' +
          '<input type="text" data-emp="' + i + '" autocomplete="off" placeholder="appearance or position, not a name" value="' + esc(emp.desc) + '"></div>';
      });
      if (draft.employees.length < 4) h += btn('+ Add E4', 'add-e4');
      else h += btn('Remove E4', 'remove-e4');
      h += '</div></div>';
    } else if (mode === 'checkout-service') {
      h += '<div class="section"><span class="label">Lanes you watch — pick 2</span>' + lanePicker(draft.lanesService) + '</div>';
    } else if (mode === 'checkout-arrivals') {
      h += '<div class="section"><span class="label">Lanes open now — pick all</span>' + lanePicker(draft.lanesOpen) +
        '<p class="hint">You can open and close lanes during the session.</p></div>';
    }
    if (ui.error) h += '<div class="err">' + esc(ui.error) + '</div>';
    h += '</div>';
    var hint = setupReady();
    h += '<div class="actionbar"><button type="button" class="primary" data-action="start-session"' + (hint ? ' disabled' : '') + '>START SESSION' +
      '<span class="sub">' + esc(hint || draft.station) + '</span></button></div>';
    app.innerHTML = h;
  }

  function timerBtn(c) {
    var started = !!c.startMs;
    var id = started ? c.startId : c.arrivalId;
    return '<button type="button" class="timer" data-action="edit-timer" data-arg="' + esc(id) + '">' +
      '<span class="label">' + (started ? 'Service' : 'Wait') + '</span>' +
      '<span class="t tnum" data-since="' + (started ? c.startMs : c.arrivalMs) + '">' +
      fmtDur((Date.now() - (started ? c.startMs : c.arrivalMs)) / 1000) + '</span></button>';
  }

  // ---- counter mode (APP_SPEC §4.2)
  function cardHtml(c, nextSeq) {
    var started = !!c.startMs;
    var isNext = c.seq === nextSeq;
    var h = '<section class="card' + (isNext ? ' next' : '') + '" data-seq="' + c.seq + '">';
    h += '<div class="card-head"><span class="cnum tnum">#' + c.seq + '</span>';
    if (isNext) h += '<span class="tag">NEXT</span>';
    if (started) h += '<span class="emp">' + esc(c.employee) + '</span>';
    h += timerBtn(c) + '</div>';

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
    if (ui.picking !== null && !open.some(function (c) { return c.seq === ui.picking && !c.startMs; })) ui.picking = null;
    var nextSeq = nextToTime();
    var h = statusBar() + toolsBand() + wakeTipHtml();
    if (ui.error) h += '<div class="err">' + esc(ui.error) + '</div>';
    h += '<div class="scroll" id="cards">';
    if (!open.length) h += '<div class="empty">No open customers. Tap ARRIVAL when a customer joins the counter.</div>';
    open.forEach(function (c) { h += cardHtml(c, nextSeq); });
    h += '</div>';
    h += '<div class="actionbar"><button type="button" class="primary" data-action="arrival">ARRIVAL' +
      '<span class="sub">Customer #' + S.nextSeq + ' · ' + esc(S.cfg.station) + '</span></button></div>';
    h += overlays();
    paint(h);
  }

  // ---- checkout service mode (APP_SPEC §4.3)
  function ccardHtml(c) {
    var started = !!c.startMs;
    var h = '<section class="ccard" data-seq="' + c.seq + '">';
    h += '<div class="card-head"><span class="cnum tnum">#' + c.seq + '</span>' + timerBtn(c) + '</div>';
    if (!started) {
      h += '<div class="row">' + btn('Start', 'start', { arg: c.seq, cls: 'fill wide' }) +
        btn('Not<br>timed', 'dismiss', { arg: c.seq, cls: 'small' }) + '</div>';
    } else {
      h += '<div class="row">' + btn('End', 'end', { arg: c.seq, cls: 'fill wide' }) +
        btn('X <span class="tnum">' + c.x + '</span>', 'interrupt', { arg: c.seq }) + '</div>';
    }
    h += '<div class="row">';
    BASKETS.forEach(function (b) {
      h += btn(b[0], 'basket', { arg: c.seq + ':' + b[0], cls: c.basket === b[0] ? 'on' : '', sub: b[1] });
    });
    h += '</div><div class="row">';
    PAYS.forEach(function (p) {
      h += btn(p[0], 'pay', { arg: c.seq + ':' + p[0], cls: c.pay === p[0] ? 'on' : '', sub: p[1] });
    });
    h += '</div></section>';
    return h;
  }

  function renderService() {
    var open = openCustomers();
    var lanes = S.cfg.lanes;
    var h = statusBar() + toolsBand() + wakeTipHtml();
    if (ui.error) h += '<div class="err">' + esc(ui.error) + '</div>';
    h += '<div class="scroll" id="cards"><div class="cols">';
    lanes.forEach(function (l) {
      var cs = open.filter(function (c) { return c.lane === l; });
      h += '<div class="lanecol" data-lane="' + esc(l) + '"><div class="colhead"><span>LANE ' + esc(l) + '</span>' +
        '<span class="label tnum">' + cs.length + ' open</span></div>';
      if (!cs.length) h += '<div class="empty small">Tap JOIN when a customer joins lane ' + esc(l) + '.</div>';
      cs.forEach(function (c) { h += ccardHtml(c); });
      h += '</div>';
    });
    h += '</div></div>';
    h += '<div class="actionbar split">';
    lanes.forEach(function (l) {
      h += '<button type="button" class="primary" data-action="join" data-arg="' + esc(l) + '">JOIN' +
        '<span class="sub">Lane ' + esc(l) + ' · #' + S.nextSeq + '</span></button>';
    });
    h += '</div>';
    h += overlays();
    paint(h);
  }

  // ---- checkout arrivals mode (APP_SPEC §4.4)
  function laneTallies(bin) {
    var inBin = {}, total = {};
    S.joins.forEach(function (j) {
      total[j.lane] = (total[j.lane] || 0) + 1;
      if (j.ms >= bin.start && j.ms < bin.end) inBin[j.lane] = (inBin[j.lane] || 0) + 1;
    });
    return { inBin: inBin, total: total };
  }

  function renderArrivals() {
    var lanes = openLaneList();
    var bin = binOf(Date.now());
    ui.lastBin = bin.start;
    var t = laneTallies(bin);
    var h = statusBar() + toolsBand() + wakeTipHtml();
    if (ui.error) h += '<div class="err">' + esc(ui.error) + '</div>';
    h += '<div class="band binbar"><span class="title tnum">Bin ' + clockLocal(bin.start).slice(0, 5) + '–' +
      clockLocal(bin.end).slice(0, 5) + '</span><span class="label tnum" id="binleft">' +
      fmtDur((bin.end - Date.now()) / 1000) + ' left</span>' +
      btn('Lanes', 'lanes-open', { cls: 'slim', sub: lanes.length + ' open' }) + '</div>';
    h += '<div class="scroll lanes-area" id="cards">';
    if (!lanes.length) h += '<div class="empty">No lanes open. Tap LANES to open one.</div>';
    h += '<div class="lanegrid">';
    // Other lane fills the empty cell when an odd number of lanes is open.
    var otherFull = lanes.length % 2 === 0;
    lanes.concat(['other']).forEach(function (l) {
      h += '<button type="button" class="lanebtn' + (l === 'other' && otherFull ? ' full' : '') + '" data-action="join-lane" data-arg="' + esc(l) + '">' +
        '<span class="ln">' + (l === 'other' ? 'OTHER LANE' : 'LANE ' + esc(l)) + '</span>' +
        '<span class="cnt tnum">' + (t.inBin[l] || 0) + '</span>' +
        '<span class="sub tnum">this bin · total ' + (t.total[l] || 0) + '</span></button>';
    });
    h += '</div></div>';
    h += overlays();
    paint(h);
  }

  function lanesHtml() {
    var h = '<div class="overlay" role="dialog" aria-label="Lanes">';
    h += '<div class="head">Open / close lanes</div><div class="body">';
    h += '<p>Tap a lane when it opens or closes. Each tap is logged with the time.</p><div class="lanepick">';
    for (var n = 1; n <= LANE_CHOICES; n++) {
      var l = String(n);
      h += btn(l, 'lane-toggle', { arg: l, cls: S.openLanes[l] ? 'fill' : '', sub: S.openLanes[l] ? 'open' : 'closed' });
    }
    h += '</div></div><div class="foot"><div class="row">' + btn('Done', 'lanes-close', { cls: 'fill' }) + '</div></div></div>';
    return h;
  }

  // ---- edit a time (APP_SPEC §4.6)
  function editableRecent() {
    var out = [];
    for (var i = S.live.length - 1; i >= 0 && out.length < 30; i--) {
      if (TIME_EDITABLE[S.live[i].event_type]) out.push(S.live[i]);
    }
    return out;
  }
  function editHtml() {
    var v = ui.edit;
    var h = '<div class="overlay" role="dialog" aria-label="Edit a time">';
    if (!v.id) {
      var list = editableRecent();
      h += '<div class="head">Edit a time</div><div class="body">';
      if (!list.length) h += '<p>Nothing to edit yet.</p>';
      list.forEach(function (e) {
        h += '<button type="button" class="lrow" data-action="edit-pick" data-arg="' + esc(e.event_id) + '">' +
          '<span>' + esc(describe(e)) + '</span><span class="tnum">' + clockLocal(S.effMs[e.event_id]) + '</span></button>';
      });
      h += '</div><div class="foot"><div class="row">' + btn('Close', 'edit-close') + '</div></div></div>';
      return h;
    }
    var target = S.byId[v.id];
    var cur = S.effMs[v.id];
    var changed = v.ms !== cur;
    h += '<div class="head">' + esc(describe(target)) + '</div><div class="body">';
    h += '<div class="timebox"><span class="label">Logged</span><span class="tnum was">' + clockLocal(cur) + '</span>' +
      '<span class="label">New</span><span class="tnum new" id="edit-new">' + clockLocal(v.ms) + '</span></div>';
    h += '<div class="pad"><div class="row">' + btn('−10 s', 'edit-adj', { arg: -10 }) + btn('−1 s', 'edit-adj', { arg: -1 }) +
      btn('+1 s', 'edit-adj', { arg: 1 }) + btn('+10 s', 'edit-adj', { arg: 10 }) + '</div></div>';
    h += '<div class="pad"><label class="label" for="in-settime">Or type the time (HHMMSS)</label><div class="row">' +
      '<input type="text" id="in-settime" inputmode="numeric" autocomplete="off" maxlength="8" placeholder="' + clockLocal(v.ms).replace(/:/g, '') + '">' +
      btn('Set', 'edit-set', { cls: 'slim' }) + '</div>' +
      (v.err ? '<p class="errtext">' + esc(v.err) + '</p>' : '') + '</div>';
    h += '</div><div class="foot"><div class="row">' + btn(v.fromList ? 'Back' : 'Cancel', 'edit-back') +
      btn('Save', 'edit-save', { cls: 'fill wide', disabled: !changed }) + '</div></div></div>';
    return h;
  }
  function openEditFor(id, fromList) {
    if (!S.effMs.hasOwnProperty(id)) return;
    ui.edit = { id: id, ms: S.effMs[id], fromList: fromList, err: '' };
    render();
  }
  function parseHms(str, refMs) {
    var d = String(str).replace(/\D/g, '');
    if (d.length !== 6) return null;
    var hh = +d.slice(0, 2), mm = +d.slice(2, 4), ss = +d.slice(4, 6);
    if (hh > 23 || mm > 59 || ss > 59) return null;
    var date = isoLocal(refMs).slice(0, 10);
    var t = Date.parse(date + 'T' + d.slice(0, 2) + ':' + d.slice(2, 4) + ':' + d.slice(4, 6) + '.000' + CFG.TZ_OFFSET);
    return isNaN(t) ? null : t;
  }

  // ---- snapshot (APP_SPEC §4.5)
  function snapshotHtml() {
    var v = ui.snapshot;
    function stepper(label, key, compact) {
      return '<div class="stepper' + (compact ? ' compact' : '') + '"><span class="label">' + label + '</span><div class="row">' +
        btn('−', 'snap-dec', { arg: key, disabled: v[key] <= 0 }) +
        '<span class="stepval tnum">' + v[key] + '</span>' +
        btn('+', 'snap-inc', { arg: key }) + '</div></div>';
    }
    var h = '<div class="overlay" role="dialog" aria-label="Snapshot">';
    h += '<div class="alarm">SNAPSHOT<span class="sub tnum">' +
      (v.scheduled ? 'Due at ' + fmtDur(v.slot * CFG.SNAPSHOT_INTERVAL_S) + ' — count now' : 'Manual snapshot') + '</span></div>';
    h += '<div class="body">';
    if (v.lanes) {
      if (!v.lanes.length) h += '<p>No lanes open.</p>';
      v.lanes.forEach(function (l) { h += stepper('Queue lane ' + esc(l), 'q:' + l, true); });
      h += stepper('Employees serving', 'serving', true);
      h += stepper('Employees present, not serving', 'idle', true);
      h += stepper('Registers open', 'registers', true);
    } else {
      h += stepper('Queue length (waiting, not being served)', 'queue');
      h += stepper('Employees serving', 'serving');
      h += stepper('Employees present, not serving', 'idle');
    }
    h += '</div>';
    h += '<div class="foot"><div class="row">' + btn('Close', 'snap-close', { cls: 'slim' }) +
      btn('Save', 'snap-save', { cls: 'fill wide' }) + '</div></div>';
    h += '</div>';
    return h;
  }
  function openSnapshot(scheduled) {
    var last = S.lastSnap;
    var v = {
      scheduled: scheduled, slot: dueSlot(), lanes: null,
      queue: 0, registers: 0,
      serving: last ? +last.employees_serving || 0 : 0,
      idle: last ? +last.employees_idle || 0 : 0
    };
    if (S.mode !== 'counter') {
      v.lanes = S.mode === 'checkout-service' ? S.cfg.lanes.slice() : openLaneList();
      v.lanes.forEach(function (l) { v['q:' + l] = 0; });
      v.registers = S.mode === 'checkout-arrivals' ? v.lanes.length : (last ? +last.registers_open || 0 : 0);
    }
    ui.snapshot = v;
    ui.confirmEnd = false;
    render();
  }

  // ---- end session (APP_SPEC §4.7)
  function confirmEndHtml() {
    return '<div class="overlay" role="dialog" aria-label="End session">' +
      '<div class="head">End session?</div>' +
      '<div class="body"><p>' + esc(S.cfg.station) + ' · ' + esc(S.cfg.observer) + '</p>' +
      '<p>Open customer cards stay as they are in the log. You can export the CSV on the next screen.</p></div>' +
      '<div class="foot"><div class="row">' + btn('Cancel', 'end-session-cancel') +
      btn('End session', 'end-session-confirm', { cls: 'fill' }) + '</div></div></div>';
  }

  var SUMMARY_TYPES = {
    'counter': ['session_start', 'arrival', 'service_start', 'service_end', 'balk', 'renege', 'interruption', 'edit', 'snapshot', 'undo', 'session_end'],
    'checkout-service': ['session_start', 'join', 'service_start', 'service_end', 'interruption', 'edit', 'snapshot', 'undo', 'session_end'],
    'checkout-arrivals': ['session_start', 'join', 'lane_open', 'lane_close', 'edit', 'snapshot', 'undo', 'session_end']
  };
  function renderSummary() {
    // Counts exclude undone events; `undo` counts every undo row.
    var byType = {};
    S.live.forEach(function (e) { byType[e.event_type] = (byType[e.event_type] || 0) + 1; });
    byType.undo = S.events.filter(function (e) { return e.event_type === 'undo'; }).length;
    var c = counts();
    var h = statusBar();
    h += '<div class="band"><span class="title">SESSION ENDED · ' + esc(S.cfg.station) + '</span><span class="ver tnum">v' + esc(CFG.APP_VERSION) + '</span></div>';
    h += '<div class="scroll">';
    h += '<div class="section"><span class="label">Events by type (undone events not counted)</span></div>';
    SUMMARY_TYPES[S.mode].forEach(function (t) {
      h += '<div class="kv" data-type="' + t + '"><span>' + t + '</span><b class="tnum">' + (byType[t] || 0) + '</b></div>';
    });
    if (S.mode !== 'counter') {
      var per = {};
      S.live.forEach(function (e) { if (e.event_type === 'join') per[e.lane] = (per[e.lane] || 0) + 1; });
      var keys = Object.keys(per).sort(function (a, b) { return a === 'other' ? 1 : b === 'other' ? -1 : laneSort(a, b); });
      if (keys.length) {
        h += '<div class="section"><span class="label">Joins per lane</span></div>';
        keys.forEach(function (l) {
          h += '<div class="kv"><span>' + (l === 'other' ? 'Other lane' : 'Lane ' + esc(l)) + '</span><b class="tnum">' + per[l] + '</b></div>';
        });
      }
    }
    h += '<div class="section"><span class="label">Sync status (every row, incl. undo rows)</span></div>';
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

  // ---------------------------------------------------------------- toast (no layout shift)
  var toastTimer = null;
  function toast(msg) {
    ui.toast = msg;
    render();
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      ui.toast = '';
      var el = app.querySelector('.toast');
      if (el) el.remove();
    }, 2500);
  }

  // ---------------------------------------------------------------- session start
  function sessionNote(cfg) {
    var mode = modeOf(cfg.station);
    if (mode === 'checkout-service') return 'lanes watched: ' + cfg.lanes.join('/');
    if (mode === 'checkout-arrivals') return 'lanes open at start: ' + cfg.lanes.join('/');
    // Employee descriptions travel in the session_start note (no other column fits).
    return cfg.employees.map(function (x) { return x.code + ': ' + x.desc; }).join(' | ');
  }
  function logSessionStart(cfg, ms) {
    var p = log('session_start', { note: sessionNote(cfg) }, ms);
    if (modeOf(cfg.station) === 'checkout-arrivals') {
      cfg.lanes.forEach(function (l) { p = log('lane_open', { lane: l }, ms); });
    }
    return p;
  }

  // ---------------------------------------------------------------- actions
  function cust(arg) { return S.customers[+arg]; }
  function attrEdit(c, field, value) {
    var f = { customer_seq: c.seq, lane: c.lane, target_event_id: c.arrivalId };
    f[field] = value;
    log('edit', f);
  }

  var actions = {
    'pick-station': function (arg) { draft.station = arg; render(); },
    'add-e4': function () { draft.employees.push({ code: 'E4', desc: '' }); render(); },
    'remove-e4': function () { draft.employees = draft.employees.slice(0, 3); render(); },
    'setup-lane': function (arg) {
      var mode = modeOf(draft.station);
      var key = mode === 'checkout-service' ? 'lanesService' : 'lanesOpen';
      var list = draft[key];
      var i = list.indexOf(arg);
      if (i >= 0) list.splice(i, 1);
      else {
        list.push(arg);
        if (mode === 'checkout-service' && list.length > 2) list.shift(); // keep the 2 most recent picks
      }
      render();
    },
    'start-session': function () {
      if (setupReady()) return;
      var observer = draft.observer.trim();
      var mode = modeOf(draft.station);
      var now = Date.now();
      var cfg = {
        session_id: uuid(), observer: observer, station: draft.station, start_ms: now,
        employees: draft.employees.map(function (x) { return { code: x.code, desc: x.desc.trim() }; }),
        lanes: (mode === 'checkout-service' ? draft.lanesService : mode === 'checkout-arrivals' ? draft.lanesOpen : [])
          .slice().sort(laneSort),
        dismissed: [], closedSlot: 0
      };
      meta.observer = observer;
      meta.lastSetup = { employees: cfg.employees, lanesService: draft.lanesService.slice(), lanesOpen: draft.lanesOpen.slice() };
      meta.current = cfg;
      saveMeta();
      S = freshState(cfg);
      rebuild();
      ui.error = '';
      logSessionStart(cfg, now);
    },
    'arrival': function () { log('arrival', { customer_seq: S.nextSeq }); },
    'join': function (lane) { log('join', { customer_seq: S.nextSeq, lane: lane }); },
    'join-lane': function (lane) { log('join', { lane: lane }); },
    'start': function (arg) {
      var c = cust(arg);
      if (!c || c.startMs || c.closed) return;
      if (S.mode === 'counter') { ui.picking = c.seq; ui.pickMs = Date.now(); render(); }
      else log('service_start', { customer_seq: c.seq, lane: c.lane });
    },
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
      if (c && c.startMs && !c.closed) log('service_end', { customer_seq: c.seq, employee: c.employee, lane: c.lane });
    },
    'balk': function (arg) { var c = cust(arg); if (c && !c.startMs && !c.closed) log('balk', { customer_seq: c.seq }); },
    'renege': function (arg) { var c = cust(arg); if (c && !c.startMs && !c.closed) log('renege', { customer_seq: c.seq }); },
    'dismiss': function (arg) {
      // APP_SPEC §4.2: an arrival-only card may be dismissed as "not timed".
      // No event type exists for this; the arrival/join event alone already means "not timed".
      var c = cust(arg);
      if (!c || c.startMs) return;
      meta.current.dismissed = (meta.current.dismissed || []).concat([c.seq]);
      saveMeta();
      render();
    },
    'interrupt': function (arg) {
      var c = cust(arg);
      if (c && !c.closed) log('interruption', { customer_seq: c.seq, employee: c.employee, lane: c.lane });
    },
    'order': function (arg) {
      var p = arg.split(':'), c = cust(p[0]);
      if (c && !c.closed && c.order !== p[1]) attrEdit(c, 'order_type', p[1]);
    },
    'basket': function (arg) {
      var p = arg.split(':'), c = cust(p[0]);
      if (c && !c.closed && c.basket !== p[1]) attrEdit(c, 'basket', p[1]);
    },
    'pay': function (arg) {
      var p = arg.split(':'), c = cust(p[0]);
      if (c && !c.closed && c.pay !== p[1]) attrEdit(c, 'pay', p[1]);
    },
    'items-inc': function (arg) { var c = cust(arg); if (c && !c.closed) attrEdit(c, 'items', c.items + 1); },
    'items-dec': function (arg) { var c = cust(arg); if (c && !c.closed && c.items > 0) attrEdit(c, 'items', c.items - 1); },

    // §4.6 undo: one tap, the button's sub-label says what will be undone.
    'undo': function () {
      var t = undoTarget();
      if (!t) return;
      var what = describe(t);
      S.pendingUndo[t.event_id] = true; // a fast double tap undoes two actions, not one twice
      log('undo', { customer_seq: t.customer_seq, lane: t.lane, target_event_id: t.event_id, note: 'undo ' + what })
        .then(function () { delete S.pendingUndo[t.event_id]; toast('Undone: ' + what); },
          function () { delete S.pendingUndo[t.event_id]; });
    },

    // §4.6 edit a time
    'edit-open': function () { ui.edit = { id: null }; render(); },
    'edit-timer': function (id) { openEditFor(id, false); },
    'edit-pick': function (id) { openEditFor(id, true); },
    'edit-adj': function (n) { ui.edit.ms += (+n) * 1000; ui.edit.err = ''; render(); },
    'edit-set': function () {
      var el = document.getElementById('in-settime');
      var t = parseHms(el ? el.value : '', ui.edit.ms);
      if (t === null) { ui.edit.err = 'Type 6 digits: hours, minutes, seconds. Example 173205 = 17:32:05.'; render(); return; }
      ui.edit.ms = t; ui.edit.err = ''; render();
    },
    'edit-back': function () { ui.edit = ui.edit.fromList ? { id: null } : null; render(); },
    'edit-close': function () { ui.edit = null; render(); },
    'edit-save': function () {
      var v = ui.edit, t = S.byId[v.id];
      ui.edit = null;
      if (!t || v.ms === S.effMs[v.id]) { render(); return; }
      log('edit', { customer_seq: t.customer_seq, lane: t.lane, target_event_id: t.event_id,
        new_timestamp: isoLocal(v.ms), note: 'time of ' + t.event_type });
    },

    // §4.4 lanes
    'lanes-open': function () { ui.lanes = true; render(); },
    'lanes-close': function () { ui.lanes = false; render(); },
    'lane-toggle': function (l) { log(S.openLanes[l] ? 'lane_close' : 'lane_open', { lane: l }); },

    // §4.5 snapshot
    'snapshot-open': function () { openSnapshot(snapshotDue()); },
    'snap-inc': function (k) { ui.snapshot[k] += 1; render(); },
    'snap-dec': function (k) { if (ui.snapshot[k] > 0) ui.snapshot[k] -= 1; render(); },
    'snap-close': function () {
      // Closing logs nothing; the Snapshot button keeps its DUE badge until one is saved.
      if (ui.snapshot.scheduled) { meta.current.closedSlot = ui.snapshot.slot; saveMeta(); }
      ui.snapshot = null; render();
    },
    'snap-save': function () {
      var v = ui.snapshot;
      ui.snapshot = null;
      var f = { employees_serving: v.serving, employees_idle: v.idle };
      if (v.lanes) {
        // Per-lane queue string, e.g. lane "1/2/5" + queue_len "3/1/4".
        f.lane = v.lanes.join('/');
        f.queue_len = v.lanes.map(function (l) { return v['q:' + l]; }).join('/');
        f.registers_open = v.registers;
      } else {
        f.queue_len = String(v.queue);
      }
      log('snapshot', f);
    },

    'wake-tip-ok': function () { meta.wakeTipDismissed = true; saveMeta(); ui.wakeTip = false; render(); },
    'end-session-ask': function () { ui.confirmEnd = true; ui.picking = null; render(); },
    'end-session-cancel': function () { ui.confirmEnd = false; render(); },
    'end-session-confirm': function () { ui.confirmEnd = false; log('session_end', {}).then(function () { ensureWake(false); }); },
    'export': function () { exportCsv(); },
    'new-session': function () {
      meta.current = null; saveMeta();
      S = null; draft = null; ui = freshUi();
      ensureWake(false);
      if (updateReady) { reloadWhenIdle(); return; }
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
    ensureWake(true); // inside the tap, so Safari treats it as user-initiated
  });
  app.addEventListener('input', function (ev) {
    if (!draft || S) return;
    var t = ev.target;
    if (t.id === 'in-observer') {
      draft.observer = t.value;
      updateStartButton();
    } else if (t.hasAttribute('data-emp')) {
      draft.employees[+t.getAttribute('data-emp')].desc = t.value;
    }
  });
  function updateStartButton() {
    var b = app.querySelector('[data-action="start-session"]');
    if (!b) return;
    var hint = setupReady();
    b.disabled = !!hint;
    b.querySelector('.sub').textContent = hint || draft.station;
  }

  // ---------------------------------------------------------------- wake lock (APP_SPEC §8)
  var wake = null, wakePending = false;
  function ensureWake(fromTap) {
    var want = S && !S.ended;
    if (!want) {
      if (wake) { var w = wake; wake = null; w.release().catch(function () {}); }
      return;
    }
    if ((wake && !wake.released) || wakePending) return;
    if (!('wakeLock' in navigator)) { showWakeTip(); return; }
    wakePending = true;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakePending = false;
      wake = lock;
      lock.addEventListener('release', function () { if (wake === lock) wake = null; });
    }, function (err) {
      wakePending = false;
      console.warn('Wake lock not available', err && err.name);
      if (fromTap) showWakeTip(); // a failure outside a tap may only mean "not visible yet"
    });
  }
  function showWakeTip() {
    if (meta.wakeTipDismissed || ui.wakeTip) return;
    ui.wakeTip = true;
    render();
  }

  // ---------------------------------------------------------------- clock tick
  function tick() {
    if (!S || S.ended) return;
    var el = document.getElementById('elapsed');
    if (el) el.textContent = fmtDur(elapsedS());
    var now = Date.now();
    var ts = app.querySelectorAll('[data-since]');
    for (var i = 0; i < ts.length; i++) ts[i].textContent = fmtDur((now - +ts[i].getAttribute('data-since')) / 1000);
    if (S.mode === 'checkout-arrivals') {
      if (binOf(now).start !== ui.lastBin) { render(); }
      else {
        var bl = document.getElementById('binleft');
        if (bl) bl.textContent = fmtDur((binOf(now).end - now) / 1000) + ' left';
      }
    }
    var due = snapshotDue();
    var snapBtn = app.querySelector('[data-action="snapshot-open"]');
    if (snapBtn && due !== snapBtn.classList.contains('amber')) render();
    if (due && !ui.snapshot && !ui.confirmEnd && dueSlot() > (meta.current.closedSlot || 0)) openSnapshot(true);
  }
  setInterval(tick, 500);
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    tick();
    ensureWake(false);
    checkForUpdate();
  });
  window.addEventListener('online', function () { if (S) render(); checkForUpdate(); });
  window.addEventListener('offline', function () { if (S) render(); });

  // ---------------------------------------------------------------- app updates
  // sw.js is cache-first, so a new version is fetched in the background. When
  // the new service worker takes over, reload once — but never in the middle of
  // a running session: then the new version loads at "New session" or next launch.
  var updateReady = false, reloading = false, swReg = null, lastUpdateCheck = 0;
  function reloadWhenIdle() {
    if (reloading) return;
    reloading = true;
    writeQueue.then(function () { location.reload(); });
  }
  function checkForUpdate() {
    if (!swReg || !navigator.onLine || Date.now() - lastUpdateCheck < 60000) return;
    lastUpdateCheck = Date.now();
    swReg.update().catch(function () {});
  }
  if ('serviceWorker' in navigator) {
    var hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (!hadController) { hadController = true; return; } // first install, not an update
      updateReady = true;
      if (!S || S.ended) reloadWhenIdle();
    });
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then(function (reg) {
        swReg = reg;
      }).catch(function (err) { console.warn('SW registration failed', err); });
    });
  }

  // ---------------------------------------------------------------- boot
  function boot() {
    DB.migrateFallback().then(function () {
      var cur = meta.current;
      if (!cur || !cur.session_id) { render(); return; }
      cur.lanes = cur.lanes || [];
      return DB.bySession(cur.session_id).then(function (events) {
        S = freshState(cur);
        events.forEach(function (e) { S.events.push(e); });
        rebuild();
        if (!events.length) {
          // session_start never reached storage: log it now rather than lose the session.
          return logSessionStart(cur, cur.start_ms);
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

  window.CFL_TEST = { buildCsv: buildCsv, isoLocal: isoLocal, COLS: COLS, state: function () { return S; },
    wake: function () { return { held: !!(wake && !wake.released), tip: ui.wakeTip }; } };
  boot();
})();
