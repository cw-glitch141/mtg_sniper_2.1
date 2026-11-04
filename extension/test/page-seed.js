/**
 * Startdaten für den Seitentest (sample.html).
 * - Watchlist-Eintrag im ALTEN Format (v1.0) → prüft die Migration
 * - Preisverlauf: Besuch vor 2 Tagen mit bestem Angebot 118,00 € inkl. Porto
 */
window.__MTGDS_SEED = {
  sync: {
    'wl:/Magic/Products/Singles/Mirrodin/Chrome-Mox': {
      name: 'Chrommox', url: 'https://www.cardmarket.com/de/Magic/Products/Singles/Mirrodin/Chrome-Mox',
      target: 120, added: 0
    }
  },
  local: {
    'hist:/Magic/Products/Singles/Mirrodin/Chrome-Mox': {
      nameKey: 'chromemox', title: 'Chrommox', expansion: 'Mirrodin', path: '/Magic/Products/Singles/Mirrodin/Chrome-Mox',
      entries: [{ t: Date.now() - 2 * 864e5, loadId: 1, price: 114.05, eff: 118.00, seller: 'Früher' }]
    },
    // Dashboard-Übertragung eingeschaltet (Token im gültigen Format, Server wird im Test nicht kontaktiert)
    dashboard: { sync: true, url: 'http://127.0.0.1:8787', token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718' }
  }
};

// Testantwort des "Dashboards": Angebot 0 = Kaufempfehlung, Angebot 1 = kein Gewinn. (Erfundene Werte, nur für den Test.)
window.__MTGDS_FAKE_RESPONSE = function (msg) {
  if (msg.type !== 'sendOffers') return { ok: false, error: 'unerwartet' };
  return {
    ok: true,
    result: {
      unmatched: 0,
      evaluations: [
        { index: 0, recommendation: 'KAUFEN', profitBase: 12.3, profitConservative: 4.1, roiBase: 21.5, score: 72, confidence: 74, reasons: ['Testbewertung'] },
        { index: 1, recommendation: 'NICHT KAUFEN', profitBase: -2.1, profitConservative: -8, roiBase: -3, score: 20, confidence: 74, reasons: [] }
      ]
    }
  };
};
