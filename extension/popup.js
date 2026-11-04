/**
 * MTG Deal Sniper – popup.js
 * Tabs: Watchlist (inkl. Deckliste + Preisverlauf), Bündeln, Einstellungen.
 */
(function () {
  'use strict';

  const P = window.MTGParser;
  const S = window.MTGShared;
  const K = S.KEYS;
  const euro = S.euro;

  const $ = id => document.getElementById(id);
  // 2.5 → "2,50" für Eingabefelder
  const money = v => (typeof v === 'number' && isFinite(v) ? v.toFixed(2).replace('.', ',') : '');

  let settings = S.normalizeSettings();
  let entries = [];          // Watchlist-Einträge (sync)
  let local = {};            // Schnappschüsse + Preisverlauf (local)

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function link(href, txt, cls) {
    const a = el('a', cls, txt);
    a.href = href; a.target = '_blank'; a.rel = 'noopener';
    return a;
  }

  // ---------------------------------------------------------------------------
  // Daten laden
  // ---------------------------------------------------------------------------

  async function loadAll() {
    const all = await chrome.storage.sync.get(null);
    const mig = S.migrateWatchlist(all);
    if (mig.remove.length) {
      await chrome.storage.sync.set(mig.set);
      await chrome.storage.sync.remove(mig.remove);
      Object.assign(all, mig.set);
      mig.remove.forEach(k => delete all[k]);
    }
    settings = S.normalizeSettings(all[K.settings]);
    entries = S.readWatchlist(all);
    local = await chrome.storage.local.get(null);
  }

  /** Alte Schnappschüsse löschen (Preisverlauf bleibt erhalten). */
  async function pruneLocal() {
    const maxAge = S.LIMITS.snapMaxAgeDays * 864e5;
    const old = Object.keys(local).filter(k => k.startsWith(K.snap) && Date.now() - (local[k].t || 0) > maxAge);
    if (old.length) {
      await chrome.storage.local.remove(old);
      old.forEach(k => delete local[k]);
    }
  }

  const snapshots = () => Object.keys(local).filter(k => k.startsWith(K.snap)).map(k => local[k]);
  const histories = () => Object.keys(local).filter(k => k.startsWith(K.hist)).map(k => local[k]);

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------

  function showTab(name) {
    document.querySelectorAll('nav button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    document.querySelectorAll('main > section').forEach(s => { s.hidden = s.id !== 'tab-' + name; });
    if (name === 'bundle') renderBundles();
  }

  // ---------------------------------------------------------------------------
  // Watchlist
  // ---------------------------------------------------------------------------

  async function saveEntry(e, fields) {
    const next = Object.assign({}, e, fields);
    delete next.key;
    await chrome.storage.sync.set({ [K.watch + e.key]: next });
    Object.assign(e, fields);
  }

  /** Preisverlauf zu einer Karte: neuester Besuch über alle Drucke + Vergleich zum Besuch davor. */
  function priceInfo(e) {
    let latest = null, prev = null, hist = null;
    histories().forEach(h => {
      if (h.nameKey !== e.key && h.nameKey !== e.alias) return;
      const list = h.entries || [];
      const last = list[list.length - 1];
      if (last && (!latest || last.t > latest.t)) {
        latest = last; prev = list.length > 1 ? list[list.length - 2] : null; hist = h;
      }
    });
    if (!latest) return null;
    const val = x => (settings.shippingEnabled ? x.eff : x.price);
    return { latest, prev, hist, value: val(latest), prevValue: prev ? val(prev) : null };
  }

  function renderWatchlist() {
    document.querySelectorAll('.incl').forEach(n => { n.textContent = settings.shippingEnabled ? ', inkl. Porto' : ''; });
    const ul = $('watchlist');
    ul.textContent = '';
    const open = entries.filter(e => !e.bought).length;
    $('wlCount').textContent = entries.length ? open + ' offen · ' + (entries.length - open) + ' gekauft' : '';
    $('clearBought').hidden = entries.length === open;

    if (!entries.length) {
      ul.append(el('li', 'empty', 'Noch keine Karten. Deckliste oben einfügen oder auf einer Kartenseite „Zur Watchlist“ klicken.'));
      return;
    }

    const sorted = entries.slice().sort((a, b) => (a.bought - b.bought) || String(a.name).localeCompare(String(b.name), 'de'));
    sorted.forEach(e => {
      const li = el('li', e.bought ? 'bought' : '');
      const line1 = el('div', 'line1');

      const cb = el('input');
      cb.type = 'checkbox'; cb.checked = !!e.bought; cb.title = 'Gekauft';
      cb.addEventListener('change', async () => { await saveEntry(e, { bought: cb.checked }); renderWatchlist(); });

      const qty = el('input', 'qty');
      qty.type = 'number'; qty.min = '1'; qty.max = '99'; qty.value = e.qty; qty.title = 'Anzahl';
      qty.addEventListener('change', () => {
        const q = parseInt(qty.value, 10);
        if (q >= 1) saveEntry(e, { qty: q }); else qty.value = e.qty;
      });

      const name = link(e.url || S.searchUrl(e.name), e.name, 'name');
      name.title = e.url ? 'Zuletzt besuchter Druck öffnen' : 'Auf Cardmarket suchen';

      const target = el('input', 'target');
      target.type = 'text'; target.inputMode = 'decimal'; target.placeholder = 'Ziel €';
      target.value = money(e.target);
      target.title = 'Zielpreis' + (settings.shippingEnabled ? ' inkl. Porto' : '');
      target.addEventListener('change', async () => {
        const t = target.value.trim() === '' ? null : P.parsePrice(target.value);
        if (t !== null && !(t > 0)) { target.value = ''; return; }
        await saveEntry(e, { target: t === null ? null : Math.round(t * 100) / 100 });
        renderWatchlist();
      });

      const del = el('button', 'del', '✕');
      del.type = 'button'; del.title = 'Von der Watchlist entfernen';
      del.addEventListener('click', async () => {
        await chrome.storage.sync.remove(K.watch + e.key);
        entries = entries.filter(x => x !== e);
        renderWatchlist();
      });

      line1.append(cb, qty, name, target, del);
      li.append(line1);

      // Zeile 2: Preisverlauf
      const line2 = el('div', 'line2 muted');
      const info = priceInfo(e);
      if (!info) {
        line2.textContent = 'Noch nicht angesehen';
      } else {
        if (!e.bought && typeof e.target === 'number' && info.value <= e.target) line2.append(el('span', 'hit', '🎯 unter Ziel'), ' ');
        line2.append('zuletzt ' + euro(info.value) + (info.hist.expansion ? ' (' + info.hist.expansion + ')' : '') +
                     ', ' + S.formatAge(Date.now() - info.latest.t));
        if (info.prevValue != null && Math.abs(info.prevValue - info.value) >= 0.01) {
          const down = info.value < info.prevValue;
          line2.append(' ', el('span', down ? 'down' : 'up', down ? '↓' : '↑'), ' vorher ' + euro(info.prevValue));
        }
      }
      li.append(line2);
      ul.append(li);
    });
  }

  async function importDecklist() {
    const { cards, skipped } = S.parseDecklist($('decklist').value);
    if (!cards.length) { $('importMsg').textContent = 'Keine Karten erkannt.'; return; }
    const writes = {};
    let added = 0, updated = 0;
    cards.forEach(c => {
      const { key, alias } = S.keysForName(c.name);
      const existing = S.findWatchEntry(entries, key) || (alias && S.findWatchEntry(entries, alias));
      if (existing) {
        // Anzahl nicht verdoppeln, wenn dieselbe Liste zweimal eingefügt wird
        const next = Object.assign({}, existing, { qty: Math.max(existing.qty, c.qty), bought: existing.bought });
        delete next.key;
        writes[K.watch + existing.key] = next;
        updated++;
      } else {
        writes[K.watch + key] = { name: c.name, qty: c.qty, bought: false, target: null, added: Date.now(), url: null, alias };
        added++;
      }
    });
    await chrome.storage.sync.set(writes);   // ein Schreibvorgang für alle Karten
    await loadAll();
    renderWatchlist();
    $('decklist').value = '';
    $('importMsg').textContent = added + ' neu, ' + updated + ' aktualisiert' +
      (skipped.length ? ', ' + skipped.length + ' Zeile(n) übersprungen' : '') + '.';
  }

  async function clearBought() {
    const keys = entries.filter(e => e.bought).map(e => K.watch + e.key);
    if (!keys.length) return;
    await chrome.storage.sync.remove(keys);
    entries = entries.filter(e => !e.bought);
    renderWatchlist();
  }

  // ---------------------------------------------------------------------------
  // Bündeln
  // ---------------------------------------------------------------------------

  function renderBundles() {
    const res = S.computeBundles(entries, snapshots(), settings);
    $('bundleInfo').textContent = res.activeCount
      ? 'Angebote bekannt für ' + res.coveredCount + ' von ' + res.activeCount + ' offenen Karten.'
      : 'Keine offenen Karten auf der Watchlist.';

    const miss = $('bundleMissing');
    miss.textContent = '';
    if (res.missing.length) {
      miss.append(el('div', 'muted', 'Noch ansehen (dann fließen die Angebote ein):'));
      res.missing.forEach(e => miss.append(link(e.url || S.searchUrl(e.name), e.name)));
    }

    const box = $('bundles');
    box.textContent = '';
    if (!res.bundles.length) {
      box.append(el('p', 'empty', res.coveredCount < 2
        ? 'Öffne mindestens zwei deiner Watchlist-Karten auf Cardmarket, dann erscheinen hier Verkäufer, die mehrere davon haben.'
        : 'Kein Verkäufer hat mehrere deiner offenen Karten (mit deinen Filtern).'));
      return;
    }

    res.bundles.slice(0, 15).forEach(b => {
      const worse = b.savings != null && b.savings < -0.005;
      const div = el('div', 'bundle' + (worse ? ' worse' : ''));
      const h = el('h3');
      h.append(link(S.sellerUrl(b.seller), b.seller), ' ');
      h.append(el('span', 'muted', b.cards + ' Karten' + (b.copies !== b.cards ? ' / ' + b.copies + ' Ex.' : '') +
        ' · ' + (b.country || '?') + (b.sales != null ? ' · ' + b.sales + ' Verkäufe' : '')));
      div.append(h);

      const ul = el('ul');
      b.items.forEach(i => {
        const li = el('li');
        const short = i.copies < i.need ? ' (nur ' + i.copies + ' von ' + i.need + ')' : '';
        li.append(el('span', null, i.copies + '× ' + i.name + ' – ' + (i.condition || '') +
          (i.expansion ? ', ' + i.expansion : '') + short));
        li.append(el('span', null, euro(i.subtotal)));
        ul.append(li);
      });
      div.append(ul);

      const sum = el('div', 'sum');
      sum.textContent = euro(b.subtotal) + (settings.shippingEnabled
        ? ' + ' + euro(b.shipping.cost) + ' Porto' + (b.shipping.tracked ? ' (versichert)' : '') + ' = ' + euro(b.total)
        : '');
      if (b.savings != null && b.savings > 0.005) {
        sum.append(' · ', el('span', 'save', 'spart ca. ' + euro(b.savings)));
      } else if (worse) {
        sum.append(' · ', el('span', 'nosave', 'lohnt nicht: Einzelkauf ' + euro(-b.savings) + ' günstiger'));
      }
      div.append(sum);
      box.append(div);
    });
  }

  // ---------------------------------------------------------------------------
  // Einstellungen
  // ---------------------------------------------------------------------------

  const MONEY_FIELDS = ['shipDomestic', 'shipDomesticTracked', 'shipIntl', 'shipIntlTracked', 'trackedFrom'];

  function fillSelect(sel, items) {
    items.forEach(it => {
      const o = el('option', null, it.label);
      o.value = it.value;
      sel.append(o);
    });
  }

  function buildSettingsForm() {
    fillSelect($('minCondition'), P.CONDITIONS.map(c => ({ value: c, label: c + (c === 'PO' ? ' (alle)' : ' oder besser') })));
    fillSelect($('reference'), S.REFERENCES);
    fillSelect($('sellerType'), S.SELLER_TYPES);
    fillSelect($('homeCountry'), S.COUNTRIES.map(c => ({ value: c.code, label: c.label })));
    P.LANGUAGES.forEach(l => {
      const label = el('label');
      const cb = el('input');
      cb.type = 'checkbox'; cb.value = l.code; cb.name = 'lang';
      label.append(cb, document.createTextNode(l.label));
      $('languages').append(label);
    });
  }

  function fillSettings(s) {
    $('threshold').value = s.threshold;
    $('minCondition').value = s.minCondition;
    $('reference').value = s.reference;
    $('includeFoil').checked = s.includeFoil;
    $('minSales').value = s.minSales;
    $('sellerType').value = s.sellerType;
    $('shippingEnabled').checked = s.shippingEnabled;
    $('homeCountry').value = s.homeCountry;
    MONEY_FIELDS.forEach(k => { $(k).value = k === 'trackedFrom' ? String(s[k]).replace('.', ',') : money(s[k]); });
    document.querySelectorAll('input[name=lang]').forEach(cb => { cb.checked = s.languages.includes(cb.value); });
  }

  function readSettings() {
    const raw = {
      threshold: Math.max(0, Math.min(100, Number($('threshold').value))),
      minCondition: $('minCondition').value,
      reference: $('reference').value,
      includeFoil: $('includeFoil').checked,
      minSales: Number($('minSales').value),
      sellerType: $('sellerType').value,
      shippingEnabled: $('shippingEnabled').checked,
      homeCountry: $('homeCountry').value,
      languages: Array.from(document.querySelectorAll('input[name=lang]:checked')).map(cb => cb.value)
    };
    MONEY_FIELDS.forEach(k => { raw[k] = P.parsePrice($(k).value); });
    return S.normalizeSettings(raw);
  }

  let statusTimer = null;
  function showStatus(msg) {
    $('status').textContent = msg;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { $('status').textContent = ''; }, 2000);
  }

  async function saveSettings() {
    settings = readSettings();
    await chrome.storage.sync.set({ [K.settings]: settings });
    showStatus(settings.languages.length ? 'Gespeichert ✓' : 'Gespeichert – Hinweis: keine Sprache gewählt, es werden keine Deals angezeigt.');
    renderWatchlist();
  }

  // ---------------------------------------------------------------------------
  // Dashboard (lokale Plattform MTG Deal Sniper 2.0)
  // ---------------------------------------------------------------------------

  function dashMsg(text) { $('dashStatus').textContent = text; }

  async function loadDashboard() {
    const d = S.normalizeDashboard(local[K.dashboard]);
    $('dashSync').checked = d.sync;
    $('dashUrl').value = d.url;
    $('dashToken').value = d.token;
  }

  function readDashboard() {
    return { sync: $('dashSync').checked, url: $('dashUrl').value, token: $('dashToken').value };
  }

  async function saveDashboard() {
    const raw = readDashboard();
    const d = S.normalizeDashboard(raw);
    if (raw.token.trim() && !d.token) { dashMsg('Token ungültig – bitte aus dem Dashboard kopieren.'); return null; }
    if (d.sync && !d.token) { dashMsg('Zum Senden wird ein Token benötigt.'); d.sync = false; $('dashSync').checked = false; }
    await chrome.storage.local.set({ [K.dashboard]: d });
    local[K.dashboard] = d;
    $('dashUrl').value = d.url;
    dashMsg(d.sync ? 'Gespeichert ✓ – Angebote geöffneter Kartenseiten werden übertragen.' : 'Gespeichert ✓ – Übertragung ist aus.');
    return d;
  }

  async function testDashboard() {
    dashMsg('Teste …');
    try {
      const r = await chrome.runtime.sendMessage({ type: 'testConnection', dashboard: S.normalizeDashboard(readDashboard()) });
      if (!r) throw new Error('keine Antwort');
      if (r.error) throw new Error(r.error);
      dashMsg('Dashboard erreichbar (Version ' + r.version + '). Token ' + (r.tokenOk ? 'gültig ✓' : 'UNGÜLTIG ✗'));
    } catch (e) {
      dashMsg('Nicht erreichbar: ' + e.message + ' – läuft "npm start"?');
    }
  }

  async function migrateToDashboard() {
    const d = await saveDashboard();
    if (!d || !d.token) return;
    dashMsg('Übertrage …');
    try {
      const r = await chrome.runtime.sendMessage({
        type: 'migrateWatchlist',
        entries: entries.map(e => ({ key: e.key, name: e.name, qty: e.qty, target: e.target, bought: e.bought, url: e.url, added: e.added }))
      });
      if (!r || !r.ok) throw new Error(r && r.error ? r.error : 'keine Antwort');
      dashMsg('Watchlist übertragen: ' + r.result.imported + ' neu, ' + r.result.merged + ' zusammengeführt, ' + r.result.skipped + ' übersprungen.');
    } catch (e) {
      dashMsg('Fehlgeschlagen: ' + e.message);
    }
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  async function init() {
    buildSettingsForm();
    await loadAll();
    await pruneLocal();
    fillSettings(settings);
    renderWatchlist();

    document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('settingsForm').addEventListener('change', saveSettings);
    $('settingsForm').addEventListener('submit', e => e.preventDefault());
    $('importBtn').addEventListener('click', importDecklist);
    $('clearBought').addEventListener('click', clearBought);
    await loadDashboard();
    $('dashSave').addEventListener('click', saveDashboard);
    $('dashSync').addEventListener('change', saveDashboard);
    $('dashTest').addEventListener('click', testDashboard);
    $('dashMigrate').addEventListener('click', migrateToDashboard);

    // Direkt einen Tab öffnen (z. B. popup.html#bundle) – praktisch für Tests
    const tab = location.hash.slice(1);
    if (['watch', 'bundle', 'settings', 'dashboard'].includes(tab)) showTab(tab);
  }

  init().catch(e => console.warn('[MTG Deal Sniper] Popup-Fehler:', e));
})();
