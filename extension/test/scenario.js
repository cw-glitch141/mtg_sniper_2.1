/**
 * Testszenario (läuft nach content.js in der Testkopie von sample.html).
 * 1. Unit-Tests: Preis-Parser, Deckliste, Porto, Kartenschlüssel, Referenzpreis, Bündelung
 * 2. Alle Angebote der Beispielseite auslesen und bewerten
 * 3. Ergebnis von content.js prüfen (Panel, Markierungen, Migration, Speicher)
 * 4. Nachgeladenes Angebot simulieren (69,00 €) → MutationObserver muss es markieren
 * Ergebnis landet als JSON in <pre id="mtgds-test-output">.
 */
(function () {
  const P = window.MTGParser;
  const S = window.MTGShared;
  const out = { unit: [], market: null, offers: [], phaseA: null, phaseB: null };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const check = (group, name, got, expected) => out.unit.push({ group, name, got, expected, ok: eq(got, expected) });

  // --- 1a. Preis-Parser ---
  [
    ['1.234,56 €', 1234.56], ['€1,234.56', 1234.56], ['113,23 €', 113.23], ['€113.23', 113.23],
    ['12 €', 12], ['1.234 €', 1234], ['€1,234', 1234], ['0,25 €', 0.25], ['€0.25', 0.25],
    ['12.345.678,90 €', 12345678.9], ['€12,345,678.90', 12345678.9], ['  86,09 € ', 86.09],
    ['1 234,56 €', 1234.56], ['0,123', 0.123], ['kein Preis', null], ['', null]
  ].forEach(([input, expected]) => check('Preis', JSON.stringify(input), P.parsePrice(input), expected));

  // --- 1b. Deckliste ---
  const deck = S.parseDecklist([
    'Deck',
    '4 Lightning Bolt',
    '2x Counterspell (MH2) 267',
    'Jace, the Mind Sculptor',
    '4 Lightning Bolt, 1 Chrome Mox',
    '',
    'Sideboard',
    'SB: 3 Pyroblast',
    '1 Delver of Secrets // Insectile Aberration',
    '// Kommentar',
    '1 Thoughtseize [THS] *F*'
  ].join('\n'));
  check('Deckliste', 'Karten', deck.cards, [
    { name: 'Lightning Bolt', qty: 8 }, { name: 'Counterspell', qty: 2 }, { name: 'Jace, the Mind Sculptor', qty: 1 },
    { name: 'Chrome Mox', qty: 1 }, { name: 'Pyroblast', qty: 3 },
    { name: 'Delver of Secrets // Insectile Aberration', qty: 1 }, { name: 'Thoughtseize', qty: 1 }
  ]);
  check('Deckliste', 'übersprungen', deck.skipped, []);

  // --- 1c. Kartenschlüssel ---
  check('Schlüssel', 'Pfad Chrome-Mox', S.keyFromProductPath('/Magic/Products/Singles/Mirrodin/Chrome-Mox'), 'chromemox');
  check('Schlüssel', 'Pfad mit -V2', S.keyFromProductPath('/Magic/Products/Singles/Magic-2010/Lightning-Bolt-V2'), 'lightningbolt');
  check('Schlüssel', 'Apostroph', S.nameKey("Sensei's Divining Top"), S.keyFromProductPath('/x/Senseis-Divining-Top'));
  check('Schlüssel', 'DFC-Alias', S.keysForName('Delver of Secrets // Insectile Aberration'),
        { key: 'delverofsecretsinsectileaberration', alias: 'delverofsecrets' });

  // --- 1d. Porto ---
  const ds = S.normalizeSettings();
  check('Porto', 'Inland 10 €', S.shippingCost(10, 'Deutschland', ds).cost, 1.25);
  check('Porto', 'Inland 30 € (versichert)', S.shippingCost(30, 'Deutschland', ds).cost, 3.95);
  check('Porto', 'Ausland 10 €', S.shippingCost(10, 'Niederlande', ds).cost, 2.5);
  check('Porto', 'Ausland 30 € (versichert)', S.shippingCost(30, 'Germany', Object.assign({}, ds, { homeCountry: 'at' })).cost, 9);
  check('Porto', 'aus', S.shippingCost(30, 'Deutschland', Object.assign({}, ds, { shippingEnabled: false })).cost, 0);
  check('Porto', '2-€-Karte kein Deal mehr (Trend 3 €)',
        S.evaluateOffer({ price: 2, condition: 'NM', language: 'en', country: 'Deutschland' }, { value: 3 }, ds).isDeal, false);
  check('Porto', '2-€-Karte ohne Porto = Deal',
        S.evaluateOffer({ price: 2, condition: 'NM', language: 'en', country: 'Deutschland' }, { value: 3 },
                        Object.assign({}, ds, { shippingEnabled: false })).isDeal, true);

  // --- 1e. Referenzpreis / Verkäuferfilter ---
  const mk = { trend: 86.09, avg30: 84.13, avg7: 84.37, avg1: 86.34 };
  check('Referenz', 'trend', S.referencePrice(mk, ds, 118).value, 86.09);
  check('Referenz', 'min', S.referencePrice(mk, Object.assign({}, ds, { reference: 'min' }), 118).value, 84.13);
  check('Referenz', 'last', S.referencePrice(mk, Object.assign({}, ds, { reference: 'last' }), 118).value, 118);
  check('Referenz', 'last ohne Besuch → Trend', S.referencePrice(mk, Object.assign({}, ds, { reference: 'last' }), null).value, 86.09);
  const offerPriv = { price: 1, condition: 'NM', language: 'en', sellerType: 'private', sales: 28 };
  check('Verkäufer', 'minSales 100 blockt 28', S.matchesFilters(offerPriv, Object.assign({}, ds, { minSales: 100 })).ok, false);
  check('Verkäufer', 'nur gewerblich blockt privat', S.matchesFilters(offerPriv, Object.assign({}, ds, { sellerType: 'pro' })).ok, false);
  check('Verkäufer', 'Powerseller erlaubt bei "power"',
        S.matchesFilters(Object.assign({}, offerPriv, { sellerType: 'power' }), Object.assign({}, ds, { sellerType: 'power' })).ok, true);

  // --- 1f. Bündelung (synthetisch) ---
  const o = (seller, price, amount, country) => ({ seller, price, amount, country: country || 'Deutschland', condition: 'NM', language: 'en', foil: false, sellerType: 'pro', sales: 1000 });
  const now = Date.now();
  const bundle = S.computeBundles(
    [{ key: 'a', name: 'A', qty: 4 }, { key: 'b', name: 'B', qty: 1 }, { key: 'c', name: 'C', qty: 1 }],
    [
      { nameKey: 'a', t: now, offers: [o('X', 1, 10), o('Y', 0.8, 4)] },
      { nameKey: 'b', t: now, offers: [o('X', 2, 1), o('Z', 1.5, 1)] },
      { nameKey: 'c', t: now - 30 * 864e5, offers: [o('X', 5, 1)] }      // zu alt → ignoriert
    ], ds, now);
  const bx = bundle.bundles[0];
  check('Bündel', 'Verkäufer', bx && bx.seller, 'X');
  check('Bündel', 'Summe 4×1 + 2 = 6 € + 1,25 Porto', bx && [bx.subtotal, bx.shipping.cost, bx.total], [6, 1.25, 7.25]);
  // Einzelkauf: A bei Y 3,20+1,25 = 4,45; B bei Z 1,50+1,25 = 2,75 → 7,20 → Bündel 0,05 € teurer
  check('Bündel', 'Ersparnis vs. Einzelkauf', bx && bx.savings, -0.05);
  check('Bündel', 'fehlend (zu alt)', bundle.missing.map(e => e.key), ['c']);

  // --- 1g. Dashboard-Anbindung (2.0) ---
  check('Dashboard', 'Produkt-ID aus der Seite', P.productId(document), 152);
  check('Dashboard', 'Artikel-ID aus Zeilen-ID', P.articleId('articleRow2176715000'), '2176715000');
  check('Dashboard', 'fremde URL wird abgelehnt', S.normalizeDashboard({ url: 'https://evil.example', token: 'abc' }).url, 'http://127.0.0.1:8787');
  check('Dashboard', 'localhost mit Port erlaubt', S.normalizeDashboard({ url: 'http://localhost:9000/' }).url, 'http://localhost:9000');
  check('Dashboard', 'ungültiger Token wird verworfen', S.normalizeDashboard({ token: 'x y' }).token, '');
  check('Dashboard', 'standardmäßig aus', S.normalizeDashboard().sync, false);
  const mapped = S.toDashboardOffers({ productId: 152, title: 'Chrommox', expansion: 'Mirrodin', url: 'u' },
    [{ id: 'articleRow1', price: 60, foil: true, condition: 'NM', language: 'en', seller: 'X', country: 'Deutschland', sellerType: 'pro', sales: 10, amount: 2 }], 'T');
  check('Dashboard', 'Angebotsformat', mapped[0], {
    externalId: 'articleRow1', productExternalId: 152, productName: null, expansionName: null, finish: 'foil', condition: 'NM', language: 'en',
    price: 60, amount: 2, seller: 'X', sellerCountry: 'Deutschland', sellerType: 'pro', sellerSales: 10, url: 'u', observedAt: 'T'
  });

  // --- 2. Angebote der Seite ---
  out.settings = ds;
  out.market = P.parseMarket(document);
  out.cardName = P.parseCardName(document);
  out.path = P.productPath(document, location);
  out.pageKey = S.keyFromProductPath(out.path);
  const ref = S.referencePrice(out.market, ds, null);
  P.findOfferRows(document).forEach(row => {
    const of = P.parseOfferRow(row);
    if (!of) return;
    const ev = S.evaluateOffer(of, ref, ds);
    out.offers.push(Object.assign(of, {
      ship: ev.ship.cost, eff: ev.eff,
      discountTrend: ev.discount,
      eligible: ev.eligible, reason: ev.reason, isDeal: ev.isDeal
    }));
  });

  const snapshot = () => ({
    panel: (document.getElementById('mtgds-panel') || {}).innerText || null,
    dealRows: Array.from(document.querySelectorAll('.mtgds-deal')).map(r => r.id),
    watchHitRows: Array.from(document.querySelectorAll('.mtgds-watch-hit')).map(r => r.id),
    badges: Array.from(document.querySelectorAll('.price-container .mtgds-badge:not(.mtgds-eval)')).map(b => b.textContent + ' | ' + b.title),
    evalBadges: Array.from(document.querySelectorAll('.mtgds-eval')).map(b => b.textContent)
  });

  setTimeout(() => {
    // --- 3. Zustand nach dem ersten Rendern ---
    out.phaseA = snapshot();

    // --- 4. Nachladen simulieren: Zeile von KaZoo2705 (NM, Englisch) klonen, Preis 69,00 € ---
    const src = Array.from(document.querySelectorAll('.article-row')).find(r => r.textContent.includes('KaZoo2705'));
    const clone = src.cloneNode(true);
    clone.id = 'articleRowSIMULIERT';
    clone.classList.remove('mtgds-deal', 'mtgds-watch-hit');
    clone.querySelectorAll('.mtgds-badge').forEach(b => b.remove());
    clone.querySelector('.seller-name a').textContent = 'SimulierterVerkaeufer';
    clone.querySelectorAll('.color-primary').forEach(p => { p.textContent = '69,00 €'; });
    // Für den Screenshot weit oben einfügen (hinter der 5. Zeile), damit sie sichtbar ist
    const body = document.querySelector('#table .table-body');
    body.insertBefore(clone, body.children[5] || null);

    setTimeout(async () => {
      out.phaseB = snapshot();
      // Speicher nach Migration + Verlauf/Schnappschuss
      const sync = await chrome.storage.sync.get(null);
      const local = await chrome.storage.local.get(null);
      out.storage = {
        syncKeys: Object.keys(sync),
        watchEntry: sync['wl:chromemox'] || null,
        histEntries: (local['hist:' + out.path] || {}).entries || [],
        snapOffers: ((local['snap:' + out.path] || {}).offers || []).length
      };
      const sent = window.__MTGDS_SENT || [];
      const first = sent[0] && sent[0].offers ? sent[0].offers : [];
      out.dashboard = {
        messages: sent.length,
        firstCount: first.length,
        firstOffer: first[0] || null,
        allHaveProductId: first.length > 0 && first.every(x => x.productExternalId === 152),
        lastContainsSimulatedRow: sent.length > 0 && (sent[sent.length - 1].offers || []).some(x => x.externalId === 'articleRowSIMULIERT')
      };
      const pre = document.createElement('pre');
      pre.id = 'mtgds-test-output';
      pre.style.display = 'none';
      pre.textContent = JSON.stringify(out);
      document.body.append(pre);
    }, 1200);
  }, 700);
})();
