/**
 * MTG Deal Sniper – background.js (Service Worker)
 *
 * Einzige Stelle, an der die Extension Netzwerk-Requests stellt – und zwar ausschließlich an das
 * EIGENE lokale Dashboard (127.0.0.1/localhost), nie an Cardmarket oder andere Server.
 * Übertragen wird nur, was der Nutzer selbst auf einer geöffneten Seite gesehen hat, und nur,
 * wenn "An Dashboard senden" im Popup ausdrücklich eingeschaltet ist.
 */
importScripts('parser.js', 'shared.js');

const S = self.MTGShared;

async function dashboard() {
  const data = await chrome.storage.local.get(S.KEYS.dashboard);
  return S.normalizeDashboard(data[S.KEYS.dashboard]);
}

async function call(d, method, path, body) {
  if (!d.token) throw new Error('Kein Token hinterlegt (Dashboard → Einstellungen).');
  const res = await fetch(d.url + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-MTGDS-Token': d.token },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000)
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { /* kein JSON */ }
  if (!res.ok) throw new Error((json && json.error) || ('HTTP ' + res.status));
  return json;
}

async function handle(msg) {
  const d = await dashboard();
  switch (msg && msg.type) {
    case 'sendOffers':
      if (!d.sync) return { ok: false, error: 'Übertragung ist deaktiviert.' };
      if (!Array.isArray(msg.offers) || !msg.offers.length) return { ok: false, error: 'Keine Angebote.' };
      return { ok: true, result: await call(d, 'POST', '/api/offers', { source: 'extension', offers: msg.offers.slice(0, 500) }) };
    case 'testConnection': {
      const target = S.normalizeDashboard(Object.assign({}, d, msg.dashboard || {}));
      const health = await fetch(target.url + '/api/health', { signal: AbortSignal.timeout(5000) }).then(r => r.json());
      // Token prüfen: harmloser schreibender Aufruf mit leerer Liste → 400 bei gültigem Token, 401 bei ungültigem.
      const res = await fetch(target.url + '/api/watchlist/import-legacy', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MTGDS-Token': target.token },
        body: JSON.stringify({ entries: [] }), signal: AbortSignal.timeout(5000)
      });
      return { ok: res.ok, version: health.version, tokenOk: res.status !== 401 };
    }
    case 'migrateWatchlist':
      return { ok: true, result: await call(d, 'POST', '/api/watchlist/import-legacy', { entries: msg.entries || [] }) };
    default:
      return { ok: false, error: 'Unbekannte Nachricht' };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Nur Nachrichten aus der eigenen Extension annehmen.
  if (sender.id !== chrome.runtime.id) return false;
  handle(msg).then(sendResponse, e => sendResponse({ ok: false, error: e && e.message ? e.message : String(e) }));
  return true; // asynchrone Antwort
});
