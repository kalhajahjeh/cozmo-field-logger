// Event store: IndexedDB first, localStorage fallback (APP_SPEC §2.1).
// Events are never deleted or modified by the app, except the `synced` flag
// that Session 2's sync queue will set.
(function () {
  'use strict';

  var DB_NAME = 'cozmo-field-logger';
  var DB_VERSION = 1;
  var LS_FALLBACK_KEY = 'cfl_fallback_events';
  var dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) { reject(new Error('no indexedDB')); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains('events')) {
          var s = db.createObjectStore('events', { keyPath: 'event_id' });
          s.createIndex('session_id', 'session_id', { unique: false });
        }
      };
      req.onsuccess = function () {
        var db = req.result;
        // iOS can close the connection when the app is backgrounded; reopen next time.
        db.onclose = function () { dbPromise = null; };
        db.onversionchange = function () { db.close(); dbPromise = null; };
        resolve(db);
      };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('indexedDB blocked')); };
    });
    dbPromise.catch(function () { dbPromise = null; });
    return dbPromise;
  }

  function idbPut(event) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('events', 'readwrite');
        tx.objectStore('events').put(event);
        tx.oncomplete = function () { resolve(); };   // durable once complete
        tx.onerror = function () { reject(tx.error); };
        tx.onabort = function () { reject(tx.error || new Error('tx aborted')); };
      });
    });
  }

  function idbBySession(sessionId) {
    return openDb().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction('events', 'readonly');
        var req = tx.objectStore('events').index('session_id').getAll(sessionId);
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function lsRead() {
    try { return JSON.parse(localStorage.getItem(LS_FALLBACK_KEY) || '[]'); }
    catch (e) { return []; }
  }

  function lsPut(event) {
    var all = lsRead();
    all.push(event);
    localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(all)); // throws if full
  }

  // Write one event. Resolves with 'idb' or 'ls'. Rejects only if both fail.
  function put(event) {
    return idbPut(event).then(function () { return 'idb'; }, function (err) {
      console.warn('IndexedDB write failed, using localStorage', err);
      lsPut(event);
      return 'ls';
    });
  }

  // All events of one session, from both stores, de-duplicated, in log order.
  function bySession(sessionId) {
    return idbBySession(sessionId).catch(function (err) {
      console.warn('IndexedDB read failed', err);
      return [];
    }).then(function (fromIdb) {
      var seen = {};
      var out = [];
      fromIdb.concat(lsRead().filter(function (e) { return e.session_id === sessionId; }))
        .forEach(function (e) {
          if (seen[e.event_id]) return;
          seen[e.event_id] = true;
          out.push(e);
        });
      out.sort(function (a, b) { return a._seq - b._seq; });
      return out;
    });
  }

  // Move fallback events into IndexedDB when it works again. The localStorage
  // copy is removed only after every event is confirmed in IndexedDB.
  function migrateFallback() {
    var pending = lsRead();
    if (!pending.length) return Promise.resolve(0);
    return Promise.all(pending.map(idbPut)).then(function () {
      var now = lsRead();
      var moved = {};
      pending.forEach(function (e) { moved[e.event_id] = true; });
      var rest = now.filter(function (e) { return !moved[e.event_id]; });
      localStorage.setItem(LS_FALLBACK_KEY, JSON.stringify(rest));
      return pending.length;
    }).catch(function () { return 0; });
  }

  window.CFL_DB = { put: put, bySession: bySession, migrateFallback: migrateFallback, open: openDb };
})();
