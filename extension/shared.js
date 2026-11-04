/**
 * MTG Deal Sniper – shared.js
 *
 * Gemeinsame Logik für Content-Script und Popup:
 *   - Einstellungen (Standardwerte, Normalisierung)
 *   - Porto-Schätzung
 *   - Bewertung eines Angebots (Filter, Referenzpreis, Rabatt)
 *   - Watchlist (Kartennamen-Schlüssel, Deckliste einlesen, Migration)
 *   - Verkäufer-Bündelung
 *
 * Keine DOM-Zugriffe auf die Cardmarket-Seite und keine Netzwerk-Requests.
 * Benötigt parser.js (MTGParser) für Zustände und Preis-Parser.
 */
(function (global) {
  'use strict';

  const P = global.MTGParser;

  // ---------------------------------------------------------------------------
  // Speicher-Schlüssel
  //   chrome.storage.sync  : settings, wl:<kartenschlüssel>   (klein, geräteübergreifend)
  //   chrome.storage.local : snap:<produktpfad>, hist:<produktpfad>  (größer, nur lokal)
  // ---------------------------------------------------------------------------
  //   chrome.storage.local : dashboard  (Verbindung zum lokalen Dashboard – Token wird bewusst NICHT synchronisiert)
  const KEYS = { settings: 'settings', watch: 'wl:', snap: 'snap:', hist: 'hist:', dashboard: 'dashboard' };

  // Verbindung zum lokalen Dashboard (MTG Deal Sniper 2.0). Standardmäßig AUS –
  // Angebote werden erst nach ausdrücklicher Aktivierung übertragen.
  const DEFAULT_DASHBOARD = { sync: false, url: 'http://127.0.0.1:8787', token: '' };

  /** Nur lokale Adressen erlauben – die Extension sendet nie an fremde Server. */
  function normalizeDashboard(d) {
    d = Object.assign({}, DEFAULT_DASHBOARD, d || {});
    d.sync = !!d.sync;
    const url = String(d.url || '').trim().replace(/\/+$/, '');
    d.url = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?$/i.test(url) ? url : DEFAULT_DASHBOARD.url;
    d.token = /^[a-f0-9]{16,128}$/i.test(String(d.token || '').trim()) ? String(d.token).trim() : '';
    return d;
  }

  /**
   * Angebote der Seite in das Format der Dashboard-API (POST /api/offers) bringen.
   * Zuordnung über die stabile Cardmarket-Produkt-ID; der Name dient nur als Rückfall.
   */
  function toDashboardOffers(page, offers, observedAt) {
    return offers.map(o => ({
      externalId: o.id || null,
      productExternalId: page.productId,
      productName: page.productId ? null : page.title,
      expansionName: page.productId ? null : page.expansion,
      finish: o.foil ? 'foil' : 'nonfoil',
      condition: o.condition,
      language: o.language,
      price: o.price,
      amount: o.amount,
      seller: o.seller,
      sellerCountry: o.country,
      sellerType: o.sellerType,
      sellerSales: o.sales,
      url: page.url,
      observedAt: observedAt
    }));
  }

  const LIMITS = {
    snapOffers: 40,        // so viele günstigste Angebote pro Seite merken
    snapMaxAgeDays: 30,    // ältere Schnappschüsse werden beim Speichern gelöscht
    bundleMaxAgeDays: 7,   // für die Bündelung nur Daten der letzten 7 Tage verwenden
    histEntries: 60        // Preisverlauf: max. Einträge pro Druck
  };

  // Länder für das Heimatland (Porto Inland/Ausland). "names" = Bezeichnungen,
  // die Cardmarket im Verkäuferstandort verwendet (DE/EN). Verifiziert: "Deutschland".
  const COUNTRIES = [
    { code: 'de', label: 'Deutschland', names: ['deutschland', 'germany'] },
    { code: 'at', label: 'Österreich', names: ['österreich', 'austria'] },
    { code: 'ch', label: 'Schweiz', names: ['schweiz', 'switzerland'] },
    { code: 'nl', label: 'Niederlande', names: ['niederlande', 'netherlands'] },
    { code: 'be', label: 'Belgien', names: ['belgien', 'belgium'] },
    { code: 'lu', label: 'Luxemburg', names: ['luxemburg', 'luxembourg'] },
    { code: 'fr', label: 'Frankreich', names: ['frankreich', 'france'] },
    { code: 'it', label: 'Italien', names: ['italien', 'italy'] },
    { code: 'es', label: 'Spanien', names: ['spanien', 'spain'] },
    { code: 'pt', label: 'Portugal', names: ['portugal'] },
    { code: 'pl', label: 'Polen', names: ['polen', 'poland'] },
    { code: 'cz', label: 'Tschechien', names: ['tschechien', 'tschechische republik', 'czech republic', 'czechia'] },
    { code: 'dk', label: 'Dänemark', names: ['dänemark', 'denmark'] },
    { code: 'se', label: 'Schweden', names: ['schweden', 'sweden'] },
    { code: 'fi', label: 'Finnland', names: ['finnland', 'finland'] },
    { code: 'ie', label: 'Irland', names: ['irland', 'ireland'] }
  ];

  const REFERENCES = [
    { value: 'trend', label: 'Trendpreis' },
    { value: 'min', label: 'Niedrigster Wert aus Trend, 30-, 7- und 1-Tages-Ø' },
    { value: 'last', label: 'Bestes Angebot beim letzten Besuch' }
  ];

  const SELLER_TYPES = [
    { value: 'all', label: 'Alle Verkäufer' },
    { value: 'power', label: 'Nur Powerseller oder gewerblich' },
    { value: 'pro', label: 'Nur gewerblich' }
  ];
  const SELLER_RANK = { private: 0, power: 1, pro: 2 };

  // Porto-Standardwerte: grobe Richtwerte (Stand 2026) – bitte im Popup an
  // deine tatsächlichen Erfahrungen mit Cardmarket anpassen.
  const DEFAULT_SETTINGS = {
    threshold: 15,            // Mindest-Rabatt in %
    minCondition: 'NM',       // schlechtester noch erlaubter Zustand
    languages: ['de', 'en'],  // erlaubte Kartensprachen (Codes aus MTGParser.LANGUAGES)
    includeFoil: false,       // Foil-Angebote mitbewerten?
    reference: 'trend',       // Vergleichsbasis, siehe REFERENCES
    minSales: 0,              // Verkäufer braucht mindestens so viele Verkäufe
    sellerType: 'all',        // siehe SELLER_TYPES
    shippingEnabled: true,    // Porto in den Preis einrechnen?
    homeCountry: 'de',
    shipDomestic: 1.25,       // Brief ohne Sendungsverfolgung, Inland
    shipDomesticTracked: 3.95,// versicherter Versand / Einschreiben, Inland
    shipIntl: 2.50,           // Brief ohne Sendungsverfolgung, Ausland
    shipIntlTracked: 9.00,    // versicherter Versand, Ausland
    trackedFrom: 25           // ab diesem Warenwert (€) gilt der versicherte Versand
  };

  // ---------------------------------------------------------------------------
  // Formatierung
  // ---------------------------------------------------------------------------

  const euro = v => v == null || !isFinite(v) ? '–' : Number(v).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });

  /** "vor 3 Std." / "vor 2 Tagen" */
  function formatAge(ms) {
    const min = Math.round(ms / 60000);
    if (min < 2) return 'gerade eben';
    if (min < 60) return 'vor ' + min + ' Min.';
    const h = Math.round(min / 60);
    if (h < 24) return 'vor ' + h + ' Std.';
    const d = Math.round(h / 24);
    return d === 1 ? 'vor 1 Tag' : 'vor ' + d + ' Tagen';
  }

  // ---------------------------------------------------------------------------
  // Einstellungen
  // ---------------------------------------------------------------------------

  function normalizeSettings(s) {
    const d = DEFAULT_SETTINGS;
    s = Object.assign({}, d, s || {});
    const num = (v, def, min) => {
      const n = typeof v === 'number' ? v : P.parsePrice(v);
      return n == null || !isFinite(n) || n < (min || 0) ? def : n;
    };
    s.threshold = num(s.threshold, d.threshold);
    if (!P.CONDITIONS.includes(s.minCondition)) s.minCondition = d.minCondition;
    if (!Array.isArray(s.languages)) s.languages = d.languages.slice();
    s.includeFoil = !!s.includeFoil;
    if (!REFERENCES.some(r => r.value === s.reference)) s.reference = d.reference;
    s.minSales = Math.round(num(s.minSales, d.minSales));
    if (!SELLER_TYPES.some(t => t.value === s.sellerType)) s.sellerType = d.sellerType;
    s.shippingEnabled = !!s.shippingEnabled;
    if (!COUNTRIES.some(c => c.code === s.homeCountry)) s.homeCountry = d.homeCountry;
    ['shipDomestic', 'shipDomesticTracked', 'shipIntl', 'shipIntlTracked', 'trackedFrom']
      .forEach(k => { s[k] = num(s[k], d[k]); });
    return s;
  }

  // ---------------------------------------------------------------------------
  // Porto
  // ---------------------------------------------------------------------------

  function countryCode(name) {
    const n = String(name || '').trim().toLowerCase();
    const c = COUNTRIES.find(x => x.names.includes(n));
    return c ? c.code : null;
  }

  /**
   * Geschätztes Porto für eine Bestellung mit Warenwert `value` bei einem
   * Verkäufer aus `country` (Ländername wie auf der Seite).
   * Unbekanntes Land wird vorsichtshalber als Ausland gerechnet.
   * Rückgabe: { cost, domestic, tracked }
   */
  function shippingCost(value, country, s) {
    if (!s.shippingEnabled) return { cost: 0, domestic: null, tracked: false };
    const domestic = countryCode(country) === s.homeCountry;
    const tracked = value >= s.trackedFrom;
    const cost = domestic
      ? (tracked ? s.shipDomesticTracked : s.shipDomestic)
      : (tracked ? s.shipIntlTracked : s.shipIntl);
    return { cost, domestic, tracked };
  }

  // ---------------------------------------------------------------------------
  // Bewertung
  // ---------------------------------------------------------------------------

  /** Rabatt in Prozent gegenüber dem Referenzpreis (positiv = günstiger). */
  function discount(price, reference) {
    if (!reference || reference <= 0 || price == null) return null;
    return (reference - price) / reference * 100;
  }

  /**
   * Vergleichsbasis je nach Einstellung.
   * `lastSeen` = bester (effektiver) Preis beim letzten Besuch oder null.
   * Rückgabe: { value, label } – value kann null sein.
   */
  function referencePrice(market, s, lastSeen) {
    const trend = market ? market.trend : null;
    if (s.reference === 'min' && market) {
      const vals = [market.trend, market.avg30, market.avg7, market.avg1].filter(v => v != null && v > 0);
      if (vals.length) return { value: Math.min.apply(null, vals), label: 'Minimum aus Trend/Ø' };
    }
    if (s.reference === 'last' && lastSeen != null) {
      return { value: lastSeen, label: 'letzter Besuch' };
    }
    return { value: trend, label: s.reference === 'last' ? 'Trend (erster Besuch)' : 'Trend' };
  }

  /** Prüft, ob ein Angebot die Filter erfüllt. Rückgabe: { ok, reason } */
  function matchesFilters(offer, s) {
    if (P.conditionRank(offer.condition) > P.conditionRank(s.minCondition)) {
      return { ok: false, reason: 'Zustand ' + offer.condition + ' schlechter als ' + s.minCondition };
    }
    if (!offer.language || !s.languages.includes(offer.language)) {
      return { ok: false, reason: 'Sprache ' + (offer.languageLabel || offer.language || '?') + ' nicht erlaubt' };
    }
    if (offer.foil && !s.includeFoil) {
      return { ok: false, reason: 'Foil ausgeschlossen' };
    }
    if (s.minSales > 0 && (offer.sales == null || offer.sales < s.minSales)) {
      return { ok: false, reason: 'Verkäufer hat ' + (offer.sales == null ? '?' : offer.sales) + ' Verkäufe (< ' + s.minSales + ')' };
    }
    if (s.sellerType !== 'all' && (SELLER_RANK[offer.sellerType] || 0) < SELLER_RANK[s.sellerType]) {
      return { ok: false, reason: 'Verkäufertyp ' + (offer.sellerType || 'privat') };
    }
    return { ok: true, reason: null };
  }

  /**
   * Bewertet ein Angebot vollständig. `ref` = Ergebnis von referencePrice().
   * eff = Preis + geschätztes Porto für den Einzelkauf dieses Angebots.
   */
  function evaluateOffer(offer, ref, s) {
    const f = matchesFilters(offer, s);
    const ship = shippingCost(offer.price, offer.country, s);
    const eff = Math.round((offer.price + ship.cost) * 100) / 100;
    const d = ref && ref.value ? discount(eff, ref.value) : null;
    return {
      eligible: f.ok,
      reason: f.reason,
      ship,
      eff,
      discount: d,
      isDeal: f.ok && d !== null && d >= s.threshold
    };
  }

  // ---------------------------------------------------------------------------
  // Watchlist (Schlüssel = normalisierter Kartenname, gilt für alle Drucke)
  // ---------------------------------------------------------------------------

  /** "Sensei's Divining Top" → "senseisdiviningtop" */
  function nameKey(str) {
    return String(str || '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]/g, '');
  }

  /** Schlüssel aus Produktpfad: ".../Mirrodin/Chrome-Mox" → "chromemox", ".../Lightning-Bolt-V2" → "lightningbolt" */
  function keyFromProductPath(path) {
    const seg = String(path || '').split('/').filter(Boolean).pop() || '';
    return nameKey(decodeURIComponent(seg).replace(/-V\d+$/i, ''));
  }

  /** Schlüssel + Alias für einen Kartennamen (Alias = Vorderseite bei "A // B"). */
  function keysForName(name) {
    const key = nameKey(name);
    const front = String(name).split('//')[0];
    const alias = String(name).includes('//') ? nameKey(front) : null;
    return { key, alias: alias && alias !== key ? alias : null };
  }

  /** Watchlist-Einträge aus einem storage.sync-Objekt (nur neues Format). */
  function readWatchlist(all) {
    return Object.keys(all || {})
      .filter(k => k.startsWith(KEYS.watch) && !k.startsWith(KEYS.watch + '/'))
      .map(k => Object.assign({ qty: 1, bought: false, target: null, alias: null }, all[k], { key: k.slice(KEYS.watch.length) }));
  }

  /** Passenden Watchlist-Eintrag zu einem Seiten-Schlüssel finden. */
  function findWatchEntry(entries, pageKey) {
    return entries.find(e => e.key === pageKey || e.alias === pageKey) || null;
  }

  /**
   * Migration vom alten Format (v1.0: Schlüssel "wl:/Magic/Products/…" pro Druck)
   * zum neuen Format (Schlüssel pro Kartenname). Rückgabe: { set, remove }.
   */
  function migrateWatchlist(all) {
    const set = {}, remove = [];
    Object.keys(all || {}).forEach(k => {
      if (!k.startsWith(KEYS.watch + '/')) return;
      const old = all[k] || {};
      const key = keyFromProductPath(k.slice(KEYS.watch.length));
      remove.push(k);
      if (!key || all[KEYS.watch + key] || set[KEYS.watch + key]) return;
      set[KEYS.watch + key] = {
        name: old.name || key, qty: 1, bought: false,
        target: typeof old.target === 'number' ? old.target : null,
        added: old.added || Date.now(), url: old.url || null, alias: null
      };
    });
    return { set, remove };
  }

  /**
   * Deckliste einlesen. Unterstützt u. a.:
   *   "4 Lightning Bolt", "4x Lightning Bolt", "Lightning Bolt",
   *   "4 Lightning Bolt (M10) 146" (Arena), "SB: 2 Pyroblast" (MTGO),
   *   "4 Lightning Bolt, 1 Chrome Mox" (kommagetrennt), Überschriften wie "Sideboard".
   * Doppelte Karten werden zusammengezählt.
   * Rückgabe: { cards: [{ name, qty }], skipped: [Zeilen] }
   */
  function parseDecklist(textIn) {
    const byKey = new Map();
    const skipped = [];
    String(textIn || '').split(/\r?\n/).forEach(rawLine => {
      let line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('#')) return;
      if (/^(deck|main ?deck|mainboard|main|sideboard|side|sb|commander|companion|maybeboard)\s*:?\s*$/i.test(line)) return;
      line = line.replace(/^SB:\s*/i, '');
      // Kommas nur trennen, wenn danach eine neue Anzahl folgt ("Jace, the Mind Sculptor" bleibt ganz)
      line.split(/,\s*(?=\d+\s*x?\s+\S)/i).forEach(part => {
        part = part.trim();
        let qty = 1, name = part;
        const m = part.match(/^(\d+)\s*x?\s+(.+)$/i);
        if (m) { qty = parseInt(m[1], 10); name = m[2]; }
        name = name
          .replace(/\s+\*[A-Z]+\*\s*$/i, '')                 // MTGO-Markierung "*F*"
          .replace(/\s+\([A-Z0-9]{2,6}\)(\s+[\w★-]+)?\s*$/i, '') // Arena "(M10) 146"
          .replace(/\s+\[[^\]]+\]\s*$/, '')                  // "[M10]"
          .trim();
        if (!name || !nameKey(name) || qty < 1) { skipped.push(rawLine.trim()); return; }
        const { key } = keysForName(name);
        const prev = byKey.get(key);
        if (prev) prev.qty += qty;
        else byKey.set(key, { name, qty });
      });
    });
    return { cards: Array.from(byKey.values()), skipped };
  }

  /** Link zur Cardmarket-Suche nach einem Kartennamen. */
  function searchUrl(name) {
    return 'https://www.cardmarket.com/de/Magic/Products/Search?searchString=' + encodeURIComponent(name);
  }

  function sellerUrl(seller) {
    return 'https://www.cardmarket.com/de/Magic/Users/' + encodeURIComponent(seller);
  }

  // ---------------------------------------------------------------------------
  // Verkäufer-Bündelung
  // ---------------------------------------------------------------------------

  /** Günstigste `need` Exemplare aus einer Angebotsliste nehmen. */
  function takeCheapest(offers, need) {
    const sorted = offers.slice().sort((a, b) => a.price - b.price);
    let copies = 0, subtotal = 0;
    for (const o of sorted) {
      const n = Math.min(o.amount || 1, need - copies);
      copies += n;
      subtotal += n * o.price;
      if (copies >= need) break;
    }
    return { copies, subtotal: Math.round(subtotal * 100) / 100 };
  }

  /**
   * Schlägt Verkäufer vor, bei denen man mehrere offene Watchlist-Karten
   * zusammen kaufen kann. Grundlage sind nur die gespeicherten Angebote der
   * Seiten, die du selbst geöffnet hast (Schnappschüsse).
   *
   * Ersparnis = Kosten, wenn man jede dieser Karten einzeln beim jeweils
   * günstigsten Verkäufer (inkl. Porto) kauft, minus Kosten des Bündels.
   * Das ist eine Orientierung, keine optimale Gesamtlösung.
   */
  function computeBundles(entries, snapshots, s, now) {
    now = now || Date.now();
    const maxAge = LIMITS.bundleMaxAgeDays * 864e5;
    const active = entries.filter(e => !e.bought);
    const entryByKey = new Map(active.map(e => [e.key, e]));

    // seller → { seller, country, sellerType, sales, items: Map(entryKey → offers[]) }
    const sellers = new Map();
    // entryKey → [{ seller, country, offers[] }] für die Einzelkauf-Rechnung
    const covered = new Set();

    snapshots.forEach(sn => {
      if (!sn || now - sn.t > maxAge) return;
      const entry = active.find(e => e.key === sn.nameKey || e.alias === sn.nameKey);
      if (!entry) return;
      (sn.offers || []).forEach(o => {
        if (!o.seller || !matchesFilters(o, s).ok) return;
        covered.add(entry.key);
        let sel = sellers.get(o.seller);
        if (!sel) {
          sel = { seller: o.seller, country: o.country, sellerType: o.sellerType, sales: o.sales, items: new Map() };
          sellers.set(o.seller, sel);
        }
        if (!sel.items.has(entry.key)) sel.items.set(entry.key, []);
        sel.items.get(entry.key).push(Object.assign({ expansion: sn.expansion }, o));
      });
    });

    // Günstigster Einzelkauf (inkl. Porto) für `copies` Exemplare einer Karte
    function bestSingle(entryKey, copies) {
      let best = null;
      sellers.forEach(sel => {
        const offers = sel.items.get(entryKey);
        if (!offers) return;
        const t = takeCheapest(offers, copies);
        if (t.copies < copies) return;
        const cost = t.subtotal + shippingCost(t.subtotal, sel.country, s).cost;
        if (best === null || cost < best) best = cost;
      });
      return best;
    }

    const bundles = [];
    sellers.forEach(sel => {
      if (sel.items.size < 2) return;
      const items = [];
      let subtotal = 0, single = 0, singleComplete = true;
      sel.items.forEach((offers, entryKey) => {
        const entry = entryByKey.get(entryKey);
        const t = takeCheapest(offers, entry.qty);
        const cheapest = offers.slice().sort((a, b) => a.price - b.price)[0];
        items.push({ key: entryKey, name: entry.name, need: entry.qty, copies: t.copies, subtotal: t.subtotal,
                     condition: cheapest.condition, expansion: cheapest.expansion });
        subtotal += t.subtotal;
        const b = bestSingle(entryKey, t.copies);
        if (b === null) singleComplete = false; else single += b;
      });
      subtotal = Math.round(subtotal * 100) / 100;
      const ship = shippingCost(subtotal, sel.country, s);
      const total = Math.round((subtotal + ship.cost) * 100) / 100;
      items.sort((a, b) => a.name.localeCompare(b.name, 'de'));
      bundles.push({
        seller: sel.seller, country: sel.country, sellerType: sel.sellerType, sales: sel.sales,
        items, cards: items.length, copies: items.reduce((n, i) => n + i.copies, 0),
        subtotal, shipping: ship, total,
        savings: singleComplete ? Math.round((single - total) * 100) / 100 : null
      });
    });

    // Größte Ersparnis zuerst; Bündel ohne Vergleichswert ans Ende; danach mehr Karten zuerst.
    const sv = b => (b.savings == null ? -Infinity : b.savings);
    bundles.sort((a, b) => (sv(b) - sv(a)) || (b.cards - a.cards) || (a.total - b.total));
    return {
      bundles,
      activeCount: active.length,
      coveredCount: covered.size,
      missing: active.filter(e => !covered.has(e.key))
    };
  }

  global.MTGShared = {
    KEYS, LIMITS, COUNTRIES, REFERENCES, SELLER_TYPES, DEFAULT_SETTINGS, DEFAULT_DASHBOARD,
    normalizeDashboard, toDashboardOffers,
    euro, formatAge, normalizeSettings,
    countryCode, shippingCost,
    discount, referencePrice, matchesFilters, evaluateOffer,
    nameKey, keyFromProductPath, keysForName, readWatchlist, findWatchEntry, migrateWatchlist,
    parseDecklist, searchUrl, sellerUrl,
    takeCheapest, computeBundles
  };
})(typeof window !== 'undefined' ? window : globalThis);
