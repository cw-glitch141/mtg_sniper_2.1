/**
 * Test-Ersatz für chrome.storage (nur für den lokalen Test in headless Chrome,
 * NICHT Teil der Extension). Wird vor parser.js/shared.js geladen.
 * Startdaten kommen aus window.__MTGDS_SEED = { sync: {...}, local: {...} }.
 */
(function () {
  const seed = window.__MTGDS_SEED || {};
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const listeners = [];

  function area(name, store) {
    const fire = changes => setTimeout(() => listeners.forEach(l => l(changes, name)), 0);
    return {
      _store: store,
      async get(keys) {
        if (keys == null) return clone(store);
        const list = typeof keys === 'string' ? [keys] : keys;
        const out = {};
        list.forEach(k => { if (k in store) out[k] = clone(store[k]); });
        return out;
      },
      async set(obj) {
        const changes = {};
        Object.keys(obj).forEach(k => { changes[k] = { oldValue: store[k], newValue: obj[k] }; store[k] = clone(obj[k]); });
        if (Object.keys(changes).length) fire(changes);
      },
      async remove(keys) {
        const list = typeof keys === 'string' ? [keys] : keys;
        const changes = {};
        list.forEach(k => { if (k in store) { changes[k] = { oldValue: store[k] }; delete store[k]; } });
        if (Object.keys(changes).length) fire(changes);
      }
    };
  }

  window.chrome = {
    storage: {
      sync: area('sync', clone(seed.sync || {})),
      local: area('local', clone(seed.local || {})),
      onChanged: { addListener: l => listeners.push(l) }
    },
    // Ersatz für den Background-Service-Worker: protokolliert Nachrichten und liefert Testantworten.
    runtime: {
      id: 'test',
      async sendMessage(msg) {
        window.__MTGDS_SENT = (window.__MTGDS_SENT || []).concat([clone(msg)]);
        return window.__MTGDS_FAKE_RESPONSE ? window.__MTGDS_FAKE_RESPONSE(msg) : { ok: false, error: 'kein Dashboard im Test' };
      }
    }
  };
})();
