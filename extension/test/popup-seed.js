/**
 * Startdaten für den Popup-Test. ACHTUNG: erfundene Testdaten (außer Chrommox,
 * angelehnt an sample.html) – sie dienen nur dazu, Watchlist, Preisverlauf und
 * Bündelung sichtbar zu machen.
 */
(function () {
  const now = Date.now(), h = 36e5, d = 864e5;
  const o = (seller, price, amount, extra) => Object.assign({
    seller, price, amount, condition: 'NM', language: 'en', languageLabel: 'Englisch', foil: false,
    sellerType: 'pro', sales: 5000, country: 'Deutschland'
  }, extra || {});
  const snap = (nameKey, title, expansion, t, offers) => ({
    nameKey, title, expansion, path: '/Magic/Products/Singles/' + expansion + '/' + title.replace(/ /g, '-'),
    url: 'https://www.cardmarket.com/de/Magic/Products/Singles/' + expansion + '/' + title.replace(/ /g, '-'), t, offers
  });
  const hist = (nameKey, title, expansion, points) => ({
    nameKey, title, expansion, path: '', entries: points.map((p, i) => ({ t: p[0], loadId: i, price: p[1], eff: p[2], seller: 'x' }))
  });

  window.__MTGDS_SEED = {
    sync: {
      settings: null,
      'wl:chromemox': { name: 'Chrome Mox', qty: 1, bought: false, target: 120, added: 1, url: 'https://www.cardmarket.com/de/Magic/Products/Singles/Mirrodin/Chrome-Mox', alias: null },
      'wl:lightningbolt': { name: 'Lightning Bolt', qty: 4, bought: false, target: null, added: 2, url: null, alias: null },
      'wl:counterspell': { name: 'Counterspell', qty: 2, bought: false, target: 2.5, added: 3, url: null, alias: null },
      'wl:forceofwill': { name: 'Force of Will', qty: 1, bought: false, target: null, added: 4, url: null, alias: null },
      'wl:thoughtseize': { name: 'Thoughtseize', qty: 2, bought: true, target: null, added: 5, url: null, alias: null }
    },
    local: {
      'snap:/cm': snap('chromemox', 'Chrome Mox', 'Mirrodin', now - 2 * h, [
        o('KaZoo2705', 115.00, 1, { sales: 28, sellerType: 'private' }),
        o('KEEPSEVEN', 118.00, 1, { sales: 62774 })
      ]),
      'snap:/lb': snap('lightningbolt', 'Lightning Bolt', 'Magic 2010', now - 1 * h, [
        o('CardShopNL', 0.70, 20, { country: 'Niederlande' }),
        o('Norman', 0.90, 2, { sales: 4395, sellerType: 'power' }),
        o('KEEPSEVEN', 1.20, 10, { sales: 62774 })
      ]),
      'snap:/cs': snap('counterspell', 'Counterspell', 'Modern Horizons 2', now - 3 * h, [
        o('bennybooh', 1.00, 2, { sales: 101, sellerType: 'private' }),
        o('CardShopNL', 1.10, 5, { country: 'Niederlande' }),
        o('KEEPSEVEN', 1.50, 3, { sales: 62774 })
      ]),
      'hist:/cm': hist('chromemox', 'Chrome Mox', 'Mirrodin', [[now - 3 * d, 117.05, 121.00], [now - 2 * h, 115.00, 118.95]]),
      'hist:/lb': hist('lightningbolt', 'Lightning Bolt', 'Magic 2010', [[now - 5 * d, 0.70, 1.95], [now - 1 * h, 0.90, 2.15]]),
      'hist:/cs': hist('counterspell', 'Counterspell', 'Modern Horizons 2', [[now - 3 * h, 1.00, 2.25]])
    }
  };
  delete window.__MTGDS_SEED.sync.settings;
})();
