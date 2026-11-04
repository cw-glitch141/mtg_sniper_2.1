/**
 * MTG Deal Sniper – content.js
 *
 * Läuft auf Cardmarket-Kartenseiten (Magic Singles). Liest die Angebote über
 * parser.js aus, bewertet sie über shared.js, markiert Deals, zeigt eine
 * Zusammenfassung und verwaltet den Watchlist-Eintrag der aktuellen Karte.
 *
 * Außerdem merkt sich die Extension lokal (chrome.storage.local):
 *   - den Preisverlauf dieses Drucks (bestes passendes Angebot je Besuch)
 *   - für Watchlist-Karten die günstigsten Angebote (für die Verkäufer-Bündelung)
 *
 * Wichtig: Es wird nur das bereits geladene DOM gelesen. Keine eigenen
 * Requests, kein Nachladen, nichts landet automatisch im Warenkorb.
 */
(function () {
  'use strict';

  const P = window.MTGParser;
  const S = window.MTGShared;
  if (!P || !S) {
    console.warn('[MTG Deal Sniper] parser.js/shared.js nicht geladen – Abbruch.');
    return;
  }

  const CLS = 'mtgds';                      // Präfix für alle eigenen CSS-Klassen
  const PANEL_ID = 'mtgds-panel';

  const path = P.productPath(document, location);     // identifiziert den Druck
  const pageKey = S.keyFromProductPath(path);          // identifiziert die Karte (alle Drucke)
  const histKey = S.KEYS.hist + path;
  const snapKey = S.KEYS.snap + path;
  const loadId = Date.now();                // ein Seitenaufruf = ein Eintrag im Preisverlauf

  let settings = S.normalizeSettings();
  let entry = null;                         // passender Watchlist-Eintrag oder null
  let prevVisit = null;                     // { t, price, eff } vom letzten Besuch dieses Drucks
  let formOpen = false;                     // Bearbeiten-Formular sichtbar?
  let lastResult = null;                    // Ergebnis des letzten Renderns (zum Speichern)
  let observer = null;
  let lastSignature = '';
  let debounceTimer = null;
  let persistTimer = null;
  // Verbindung zum lokalen Dashboard (nur aktiv, wenn im Popup eingeschaltet)
  let dash = S.normalizeDashboard();
  let evals = new Map();                    // Angebots-ID → Bewertung des Dashboards
  let lastSentSig = '';
  let dashStatus = null;                    // { t, sent, buy, unmatched } oder { error }

  const euro = S.euro;
  const pct = d => Math.round(d) + ' %';
  // Rabatt als Badge-Text: 23 % günstiger → "-23 %", 10 % teurer → "+10 %"
  const badgeText = d => (d >= 0 ? '-' : '+') + pct(Math.abs(d));

  function el(tag, cls, txt) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt != null) e.textContent = txt;
    return e;
  }

  function button(label, primary, onClick) {
    const b = el('button', CLS + '-btn' + (primary ? ' ' + CLS + '-btn-primary' : ''), label);
    b.type = 'button';
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  // ---------------------------------------------------------------------------
  // Speicher
  // ---------------------------------------------------------------------------

  async function loadState() {
    try {
      const all = await chrome.storage.sync.get(null);
      // Einmalige Umstellung vom alten Watchlist-Format (pro Druck → pro Kartenname)
      const mig = S.migrateWatchlist(all);
      if (mig.remove.length) {
        await chrome.storage.sync.set(mig.set);
        await chrome.storage.sync.remove(mig.remove);
        Object.assign(all, mig.set);
        mig.remove.forEach(k => delete all[k]);
      }
      settings = S.normalizeSettings(all[S.KEYS.settings]);
      entry = S.findWatchEntry(S.readWatchlist(all), pageKey);
      const local = await chrome.storage.local.get(S.KEYS.dashboard);
      dash = S.normalizeDashboard(local[S.KEYS.dashboard]);
    } catch (e) {
      console.warn('[MTG Deal Sniper] Einstellungen konnten nicht geladen werden, nutze Standardwerte.', e);
      settings = S.normalizeSettings();
      entry = null;
    }
  }

  /** Letzten Besuch dieses Drucks aus dem Preisverlauf holen (nur einmal pro Seitenaufruf). */
  async function loadPrevVisit() {
    try {
      const data = await chrome.storage.local.get(histKey);
      const hist = data[histKey];
      const older = hist && hist.entries ? hist.entries.filter(h => h.loadId !== loadId) : [];
      prevVisit = older.length ? older[older.length - 1] : null;
    } catch (e) {
      prevVisit = null;
    }
  }

  async function saveEntry(fields) {
    const key = entry ? entry.key : pageKey;
    const base = entry ? Object.assign({}, entry) : {
      name: P.parseCardName(document) || pageKey, qty: 1, bought: false, target: null,
      added: Date.now(), alias: null
    };
    delete base.key;
    const next = Object.assign(base, { url: location.origin + location.pathname }, fields);
    await chrome.storage.sync.set({ [S.KEYS.watch + key]: next });
    // Neu-Rendern passiert über storage.onChanged.
  }

  async function removeEntry() {
    if (entry) await chrome.storage.sync.remove(S.KEYS.watch + entry.key);
  }

  /** Preisverlauf + (für offene Watchlist-Karten) Angebots-Schnappschuss speichern. */
  async function persist() {
    const r = lastResult;
    if (!r || !r.offers.length) return;
    try {
      const writes = {};
      const title = P.parseCardName(document);
      const expansion = P.expansionFromPath(path);

      // --- Preisverlauf: bestes passendes Angebot dieses Besuchs ---
      const eligible = r.offers.filter(o => o.ev.eligible);
      if (eligible.length) {
        const best = eligible.reduce((a, b) => (b.ev.eff < a.ev.eff ? b : a));
        const data = await chrome.storage.local.get(histKey);
        const hist = data[histKey] || { nameKey: pageKey, title, expansion, path, entries: [] };
        const point = { t: Date.now(), loadId, price: best.offer.price, eff: best.ev.eff, seller: best.offer.seller };
        const i = hist.entries.findIndex(h => h.loadId === loadId);
        if (i === -1) hist.entries.push(point); else hist.entries[i] = point;
        hist.entries = hist.entries.slice(-S.LIMITS.histEntries);
        Object.assign(hist, { nameKey: pageKey, title, expansion });
        writes[histKey] = hist;
      }

      // --- Schnappschuss für die Bündelung (nur offene Watchlist-Karten) ---
      if (entry && !entry.bought) {
        const offers = r.offers
          .map(o => o.offer)
          .sort((a, b) => a.price - b.price)
          .slice(0, S.LIMITS.snapOffers)
          .map(o => ({
            seller: o.seller, price: o.price, condition: o.condition, language: o.language,
            languageLabel: o.languageLabel, foil: o.foil, sellerType: o.sellerType, sales: o.sales,
            country: o.country, amount: o.amount
          }));
        writes[snapKey] = { nameKey: pageKey, title, expansion, path, url: location.origin + location.pathname, t: Date.now(), offers };
      }

      if (Object.keys(writes).length) await chrome.storage.local.set(writes);

      // Link im Watchlist-Eintrag auf den zuletzt besuchten Druck setzen
      const url = location.origin + location.pathname;
      if (entry && entry.url !== url) await saveEntry({ url });
    } catch (e) {
      console.warn('[MTG Deal Sniper] Speichern von Preisverlauf/Angeboten fehlgeschlagen:', e);
    }
    await syncDashboard(r);
  }

  /**
   * Gesehene Angebote an das lokale Dashboard senden (nur nach ausdrücklicher Aktivierung).
   * Es werden ausschließlich die bereits geladenen Zeilen dieser Seite übertragen – kein Nachladen.
   */
  async function syncDashboard(r) {
    if (!dash.sync || !dash.token || !chrome.runtime || !chrome.runtime.sendMessage) return;
    const sig = r.offers.map(o => o.offer.id + ':' + o.offer.price).join('|');
    if (!sig || sig === lastSentSig) return;
    lastSentSig = sig;
    const page = {
      productId: P.productId(document), title: P.parseCardName(document),
      expansion: P.expansionFromPath(path), url: location.origin + location.pathname
    };
    const list = r.offers.map(o => o.offer);
    try {
      const resp = await chrome.runtime.sendMessage({ type: 'sendOffers', offers: S.toDashboardOffers(page, list, new Date().toISOString()) });
      if (!resp || !resp.ok) throw new Error(resp && resp.error ? resp.error : 'keine Antwort');
      evals = new Map();
      (resp.result.evaluations || []).forEach(ev => {
        const off = ev.index != null ? list[ev.index] : null;
        if (off && off.id) evals.set(off.id, ev);
      });
      dashStatus = {
        t: Date.now(), sent: list.length, unmatched: resp.result.unmatched || 0,
        buy: (resp.result.evaluations || []).filter(e => e.recommendation === 'KAUFEN').length
      };
    } catch (e) {
      dashStatus = { error: e.message || String(e) };
      lastSentSig = '';   // beim nächsten Rendern erneut versuchen
    }
    render();
  }

  // ---------------------------------------------------------------------------
  // Aufräumen eigener Markierungen
  // ---------------------------------------------------------------------------

  function clearMarks() {
    document.querySelectorAll('.' + CLS + '-badge').forEach(n => n.remove());
    document.querySelectorAll('.' + CLS + '-deal, .' + CLS + '-watch-hit').forEach(n => {
      n.classList.remove(CLS + '-deal', CLS + '-watch-hit');
    });
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.remove();
  }

  // ---------------------------------------------------------------------------
  // Hauptlogik
  // ---------------------------------------------------------------------------

  function render() {
    // Beobachter pausieren, damit eigene DOM-Änderungen keine Endlosschleife auslösen.
    // disconnect() verwirft außerdem noch nicht ausgelieferte Mutationen.
    if (observer) observer.disconnect();
    try {
      clearMarks();
      lastResult = renderInner();
    } catch (e) {
      // Niemals die Seite kaputt machen – nur protokollieren.
      console.warn('[MTG Deal Sniper] Fehler beim Auswerten der Seite:', e);
    } finally {
      observe();
    }
    clearTimeout(persistTimer);
    persistTimer = setTimeout(persist, 500);
  }

  function renderInner() {
    const rows = P.findOfferRows(document);
    lastSignature = rows.map(r => r.id).join('|');
    const market = P.parseMarket(document);
    const lastSeen = prevVisit ? (settings.shippingEnabled ? prevVisit.eff : prevVisit.price) : null;
    const ref = S.referencePrice(market, settings, lastSeen);

    // Angebote auslesen und bewerten
    const offers = [];
    rows.forEach(row => {
      const offer = P.parseOfferRow(row);
      if (!offer) return;
      offers.push({ row, offer, ev: S.evaluateOffer(offer, ref, settings) });
    });

    // --- Deals markieren (nur wenn ein Referenzpreis vorhanden ist) ---
    const deals = ref.value ? offers.filter(o => o.ev.isDeal) : [];
    deals.forEach(o => {
      o.row.classList.add(CLS + '-deal');
      o.row.querySelectorAll(P.SELECTORS.priceAll).forEach(priceEl => {
        const b = el('span', CLS + '-badge', badgeText(o.ev.discount));
        b.title = priceTooltip(o) + ' · Referenz (' + ref.label + '): ' + euro(ref.value);
        priceEl.insertAdjacentElement('beforebegin', b);
      });
    });

    // --- Bewertung durch das Dashboard (Netto-Gewinn nach allen Kosten) ---
    offers.forEach(o => {
      const ev = o.offer.id ? evals.get(o.offer.id) : null;
      if (!ev || ev.profitBase == null) return;
      const priceEl = o.row.querySelector(P.SELECTORS.price);
      if (!priceEl) return;
      const buy = ev.recommendation === 'KAUFEN';
      const b = el('span', CLS + '-badge ' + CLS + '-eval' + (buy ? ' ' + CLS + '-eval-buy' : ''),
        (buy ? '✓ ' : '') + 'netto ' + (ev.profitBase >= 0 ? '+' : '') + euro(ev.profitBase));
      b.title = 'Dashboard: ' + ev.recommendation + ' · Gewinn Basis ' + euro(ev.profitBase) +
        ' (konservativ ' + euro(ev.profitConservative) + ') · ROI ' + (ev.roiBase == null ? '–' : ev.roiBase + ' %') +
        ' · Score ' + Math.round(ev.score) + ' · Confidence ' + Math.round(ev.confidence) +
        (ev.reasons && ev.reasons.length ? '\n' + ev.reasons.join('\n') : '');
      priceEl.insertAdjacentElement('afterend', b);
    });

    // --- Watchlist-Treffer markieren (Preis inkl. Porto ≤ Zielpreis) ---
    let hits = [];
    if (entry && !entry.bought && typeof entry.target === 'number') {
      hits = offers.filter(o => o.ev.eligible && o.ev.eff <= entry.target);
      hits.forEach(o => o.row.classList.add(CLS + '-watch-hit'));
    }

    const result = { market, ref, offers, deals, hits };
    // Wenn gar nichts lesbar war: Seite unverändert lassen (Warnungen stehen in der Konsole).
    if (market || offers.length) renderPanel(result);
    return result;
  }

  function priceTooltip(o) {
    if (!settings.shippingEnabled) return euro(o.offer.price);
    return euro(o.offer.price) + ' + ' + euro(o.ev.ship.cost) + ' Porto' +
      (o.ev.ship.tracked ? ' (versichert)' : '') + ' = ' + euro(o.ev.eff);
  }

  /** "113,23 € + 1,25 € Porto" bzw. nur "113,23 €" */
  function priceWithShipping(o) {
    if (!settings.shippingEnabled) return euro(o.offer.price);
    return euro(o.offer.price) + ' + ' + euro(o.ev.ship.cost) + ' Porto';
  }

  // ---------------------------------------------------------------------------
  // Panel oben auf der Seite (Zusammenfassung + Watchlist)
  // ---------------------------------------------------------------------------

  function renderPanel({ market, ref, offers, deals, hits }) {
    const anchor = document.querySelector(P.SELECTORS.insertAfter);
    if (!anchor) {
      P.warn('Einfügepunkt für die Zusammenfassung nicht gefunden (Selektor "' + P.SELECTORS.insertAfter + '").');
      return;
    }

    const panel = el('div', CLS + '-panel');
    panel.id = PANEL_ID;
    const cheapestOf = list => list.reduce((a, b) => (b.ev.eff < a.ev.eff ? b : a));

    // --- Watchlist-Alarm (deutlich, ganz oben) ---
    if (hits.length) {
      const best = cheapestOf(hits);
      const alarm = el('div', CLS + '-alert');
      alarm.append(
        el('strong', null, '🎯 Watchlist-Treffer! '),
        document.createTextNode(
          hits.length + (hits.length === 1 ? ' Angebot liegt' : ' Angebote liegen') +
          ' bei oder unter deinem Zielpreis von ' + euro(entry.target) +
          (settings.shippingEnabled ? ' (inkl. Porto)' : '') +
          '. Günstigstes: ' + priceWithShipping(best) + ' von ' + (best.offer.seller || '?') + '.'
        )
      );
      panel.append(alarm);
    }

    // --- Zusammenfassung ---
    const summary = el('div', CLS + '-summary');
    const eligible = offers.filter(o => o.ev.eligible);
    if (!ref.value) {
      summary.append(el('strong', null, 'MTG Deal Sniper: '),
        document.createTextNode('Kein Referenzpreis gefunden – Rabatte können nicht berechnet werden.'));
    } else if (deals.length) {
      const best = cheapestOf(deals);
      summary.append(
        el('strong', null, deals.length + (deals.length === 1 ? ' Deal' : ' Deals') + ' gefunden'),
        document.createTextNode(', bestes Angebot: ' + priceWithShipping(best) + ' (' + badgeText(best.ev.discount) + ')')
      );
    } else {
      summary.append(el('strong', null, 'Keine Deals gefunden'));
      if (eligible.length) {
        const cheapest = cheapestOf(eligible);
        summary.append(document.createTextNode(
          ' – günstigstes passendes Angebot: ' + priceWithShipping(cheapest) +
          (cheapest.ev.discount != null ? ' (' + badgeText(cheapest.ev.discount) + ')' : '')));
      }
    }
    panel.append(summary);

    // --- Detailzeilen ---
    const d1 = ['Vergleich mit ' + ref.label + ' ' + euro(ref.value)];
    if (market) {
      if (ref.label !== 'Trend') d1.push('Trend ' + euro(market.trend));
      d1.push('30-Tage-Ø ' + euro(market.avg30));
    }
    d1.push('Schwelle ' + settings.threshold + ' %');
    if (settings.shippingEnabled) {
      d1.push('Porto Inland ' + euro(settings.shipDomestic) + ', Ausland ' + euro(settings.shipIntl) +
              ', ab ' + euro(settings.trackedFrom) + ' versichert');
    }
    panel.append(el('div', CLS + '-details', d1.join(' · ')));

    const d2 = [eligible.length + ' von ' + offers.length + ' geladenen Angeboten passen zu deinen Filtern (ab ' + settings.minCondition + ')'];
    if (prevVisit) {
      d2.push('letzter Besuch ' + S.formatAge(Date.now() - prevVisit.t) + ': bestes Angebot ' +
              euro(settings.shippingEnabled ? prevVisit.eff : prevVisit.price));
    }
    panel.append(el('div', CLS + '-details', d2.join(' · ')));

    // --- Dashboard-Status ---
    if (dash.sync) {
      let txt;
      if (!dash.token) txt = 'Dashboard: kein Token hinterlegt (Popup → Dashboard).';
      else if (!dashStatus) txt = 'Dashboard: übertrage …';
      else if (dashStatus.error) txt = 'Dashboard nicht erreichbar: ' + dashStatus.error;
      else txt = 'Dashboard: ' + dashStatus.sent + ' Angebote übertragen, ' + dashStatus.buy + ' Kaufempfehlung(en)' +
        (dashStatus.unmatched ? ', ' + dashStatus.unmatched + ' ohne Produktzuordnung' : '') + ' · Netto-Gewinn steht neben dem Preis.';
      panel.append(el('div', CLS + '-details', txt));
    }

    // --- Watchlist-Bereich ---
    panel.append(renderWatchControls());

    anchor.insertAdjacentElement('afterend', panel);
  }

  function renderWatchControls() {
    const box = el('div', CLS + '-watch');

    if (formOpen) {
      const form = el('form', CLS + '-watch-form');

      const qtyLabel = el('label', null, 'Anzahl: ');
      const qty = el('input');
      qty.type = 'number'; qty.min = '1'; qty.max = '99'; qty.className = CLS + '-qty';
      qty.value = entry ? entry.qty : 1;
      qtyLabel.append(qty);

      const targetLabel = el('label', null, 'Zielpreis (€' + (settings.shippingEnabled ? ', inkl. Porto' : '') + '): ');
      const target = el('input');
      target.type = 'text'; target.inputMode = 'decimal'; target.placeholder = 'optional';
      target.value = entry && typeof entry.target === 'number' ? String(entry.target).replace('.', ',') : '';
      targetLabel.append(target);

      const save = el('button', CLS + '-btn ' + CLS + '-btn-primary', 'Speichern');
      save.type = 'submit';
      const cancel = button('Abbrechen', false, () => { formOpen = false; render(); });
      const err = el('span', CLS + '-error');
      form.append(qtyLabel, targetLabel, save, cancel, err);

      form.addEventListener('submit', async e => {
        e.preventDefault();
        const q = parseInt(qty.value, 10);
        const t = target.value.trim() === '' ? null : P.parsePrice(target.value);
        if (!(q >= 1)) { err.textContent = 'Anzahl muss mindestens 1 sein.'; return; }
        if (t !== null && !(t > 0)) { err.textContent = 'Bitte einen gültigen Preis eingeben oder leer lassen.'; return; }
        formOpen = false;
        try {
          await saveEntry({ qty: q, target: t === null ? null : Math.round(t * 100) / 100 });
        } catch (ex) {
          console.warn('[MTG Deal Sniper] Speichern fehlgeschlagen:', ex);
          render();
        }
      });
      box.append(form);
      setTimeout(() => (entry ? target : qty).focus(), 0);
      return box;
    }

    if (!entry) {
      box.append(button('☆ Zur Watchlist', true, () => { formOpen = true; render(); }));
      return box;
    }

    if (entry.bought) {
      box.append(el('span', null, '✓ Auf deiner Watchlist als gekauft markiert '),
        button('Doch nicht gekauft', false, () => saveEntry({ bought: false })),
        button('Entfernen', false, () => removeEntry()));
      return box;
    }

    const info = '★ Auf deiner Watchlist: ' + entry.qty + '× · ' +
      (typeof entry.target === 'number'
        ? 'Zielpreis ' + euro(entry.target) + (settings.shippingEnabled ? ' inkl. Porto' : '')
        : 'kein Zielpreis') + ' ';
    box.append(el('span', null, info),
      button('Bearbeiten', false, () => { formOpen = true; render(); }),
      button('✓ Gekauft', false, () => saveEntry({ bought: true })),
      button('Entfernen', false, () => removeEntry()));
    return box;
  }

  // ---------------------------------------------------------------------------
  // Nachgeladene Angebote erkennen
  // ---------------------------------------------------------------------------

  function observe() {
    if (!observer) {
      observer = new MutationObserver(() => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          // Nur neu auswerten, wenn sich die Menge der Angebotszeilen geändert hat
          // (Tooltips o. Ä. lösen sonst ständig Mutationen aus).
          const sig = Array.from(document.querySelectorAll(P.SELECTORS.offerRow)).map(r => r.id).join('|');
          if (sig !== lastSignature) render();
        }, 300);
      });
    }
    // Den Hauptinhalt beobachten (nicht nur die Tabelle), damit es auch funktioniert,
    // wenn Cardmarket die komplette Tabelle austauscht.
    const root = document.querySelector(P.SELECTORS.observeRoot) || document.body;
    observer.observe(root, { childList: true, subtree: true });
  }

  // ---------------------------------------------------------------------------
  // Start
  // ---------------------------------------------------------------------------

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[S.KEYS.dashboard]) {
      dash = S.normalizeDashboard(changes[S.KEYS.dashboard].newValue);
      lastSentSig = '';
      dashStatus = null;
      if (!dash.sync) evals = new Map();
      render();
      return;
    }
    if (area !== 'sync') return;    // lokale Schreibvorgänge (Verlauf, Schnappschüsse) ignorieren
    const relevant = Object.keys(changes).some(k => k === S.KEYS.settings || k.startsWith(S.KEYS.watch));
    if (relevant) loadState().then(render);
  });

  Promise.all([loadState(), loadPrevVisit()]).then(render);
})();
