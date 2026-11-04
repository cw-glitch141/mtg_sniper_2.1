/**
 * MTG Deal Sniper – parser.js
 *
 * Reine Lese-Logik: liest Marktwerte und Angebote aus dem DOM der aktuell
 * geöffneten Cardmarket-Kartenseite. Verändert die Seite NICHT und stellt
 * KEINE Netzwerk-Requests.
 *
 * Bewertung (Rabatt, Porto, Filter) steckt in shared.js.
 *
 * Alle Selektoren wurden aus einer gespeicherten Kartenseite abgeleitet
 * (sample.html, Chrommox/Mirrodin, deutsche Oberfläche, Stand 04.11.2026).
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------------------
  // SELEKTOREN – bei Layoutänderungen von Cardmarket NUR HIER anpassen.
  // ---------------------------------------------------------------------------
  const SELECTORS = {
    // --- Info-Box mit Marktwerten ---
    // <div class="info-list-container"><dl class="labeled"><dt>Preis-Trend</dt><dd><span>86,09 €</span></dd>…
    infoList: '.info-list-container dl.labeled',
    infoLabel: 'dt',                       // Beschriftung; der Wert steht im direkt folgenden <dd>

    // --- Kartenname / Identität ---
    // <h1>Chrommox<span class="h4 …"> Mirrodin - Chrome Mox - Einzelkarten</span></h1>
    cardTitle: 'h1',
    canonicalLink: 'link[rel="canonical"]',
    // Stabile Cardmarket-Produkt-ID aus dem Filterformular: <input type="hidden" name="idProduct" value="152">
    productId: 'input[name="idProduct"]',

    // --- Angebotstabelle ---
    observeRoot: 'main',                   // Bereich, den der MutationObserver auf neue Zeilen beobachtet
    offerRow: '#table .article-row',       // <div id="articleRow2176715000" class="row g-0 article-row">

    // --- Innerhalb einer Angebotszeile ---
    sellerName: '.seller-name a[href*="/Users/"]',
    // <span class="icon d-flex …" aria-label="Artikelstandort: Deutschland">
    sellerLocation: '.seller-name span.icon[aria-label]',
    // <span class="badge … sell-count" data-bs-original-title="62774 Verkäufe | 16143 Verfügbare Artikel">62K</span>
    sellerSales: '.seller-name .sell-count',
    // <span class="fonticon-users-professional" aria-label="Gewerblich"> bzw. fonticon-users-powerseller
    sellerTypeIcon: '.seller-name [class*="fonticon-users-"]',
    // <a class="article-condition condition-ex"><span class="badge">EX</span></a>
    condition: '.product-attributes .article-condition .badge',
    // Sprache, Foil, Signiert usw. sind Icons mit aria-label in .product-attributes
    attributeIcons: '.product-attributes [aria-label]',
    // Preis gibt es doppelt (Desktop + Mobil). Wir lesen die Desktop-Variante …
    price: '.col-offer .price-container .color-primary',
    // … markieren aber beide Stellen mit dem Rabatt-Badge.
    priceAll: '.price-container .color-primary, .mobile-offer-container .color-primary',
    amount: '.col-offer .amount-container .item-count',

    // --- Einfügepunkt für Zusammenfassung / Watchlist-Button ---
    insertAfter: '.page-title-container'
  };

  // Erkennung der Beschriftungen in der Info-Box (mehrsprachig per Regex):
  //   DE: "Preis-Trend", "30-Tages-Durchschnitt", "7-Tages-…", "1-Tages-…"
  //   EN: "Price Trend", "30-days average price", "7-days …", "1-day …"
  const LABEL_PATTERNS = {
    trend: /trend|tendan|tendenc/i,
    avg30: /\b30\b/,
    avg7: /\b7\b/,
    avg1: /\b1\b/
  };

  // Präfix vor dem Verkäuferland ("Artikelstandort: Deutschland" / "Item location: Germany").
  const LOCATION_SPLIT = /:\s*/;

  // Foil-Icon: aria-label "Foil" (gleich in DE und EN).
  const FOIL_PATTERN = /^foil$/i;

  // Verkäufertyp anhand der Icon-Klasse. Ohne Icon = privat.
  const SELLER_TYPE_CLASSES = { professional: 'pro', powerseller: 'power' };

  // ---------------------------------------------------------------------------
  // Fachliche Konstanten
  // ---------------------------------------------------------------------------

  // Zustände von bestem (MT) zu schlechtestem (PO).
  const CONDITIONS = ['MT', 'NM', 'EX', 'GD', 'LP', 'PL', 'PO'];

  // Kartensprachen. "names" = Bezeichnungen, die Cardmarket als aria-label
  // verwendet (deutsche und englische Oberfläche). Verglichen wird ohne
  // Groß-/Kleinschreibung. Aus der Beispielseite verifiziert: "Deutsch", "Englisch".
  const LANGUAGES = [
    { code: 'en', label: 'Englisch',             names: ['englisch', 'english'] },
    { code: 'de', label: 'Deutsch',              names: ['deutsch', 'german'] },
    { code: 'fr', label: 'Französisch',          names: ['französisch', 'french'] },
    { code: 'it', label: 'Italienisch',          names: ['italienisch', 'italian'] },
    { code: 'es', label: 'Spanisch',             names: ['spanisch', 'spanish'] },
    { code: 'pt', label: 'Portugiesisch',        names: ['portugiesisch', 'portuguese'] },
    { code: 'ja', label: 'Japanisch',            names: ['japanisch', 'japanese'] },
    { code: 'ko', label: 'Koreanisch',           names: ['koreanisch', 'korean'] },
    { code: 'ru', label: 'Russisch',             names: ['russisch', 'russian'] },
    { code: 'zhs', label: 'Chinesisch (vereinf.)', names: ['s-chinese', 'chinesisch (vereinfacht)', 'vereinfachtes chinesisch', 'simplified chinese'] },
    { code: 'zht', label: 'Chinesisch (trad.)',   names: ['t-chinese', 'chinesisch (traditionell)', 'traditionelles chinesisch', 'traditional chinese'] }
  ];

  // ---------------------------------------------------------------------------
  // Hilfsfunktionen
  // ---------------------------------------------------------------------------

  // Jede Warnung nur einmal pro Seite ausgeben, damit die Konsole lesbar bleibt.
  const warned = new Set();
  function warn(msg) {
    if (warned.has(msg)) return;
    warned.add(msg);
    console.warn('[MTG Deal Sniper] ' + msg);
  }

  function text(el) {
    return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
  }

  /**
   * Robuster Preis-Parser für deutsches und englisches Format.
   *   "1.234,56 €" → 1234.56     "€1,234.56" → 1234.56
   *   "113,23 €"   → 113.23      "12 €"      → 12
   *   "1.234 €"    → 1234        "0,5"       → 0.5
   * Gibt null zurück, wenn keine Zahl erkennbar ist.
   */
  function parsePrice(raw) {
    if (raw == null) return null;
    // Nur Ziffern und Trennzeichen behalten (entfernt €, EUR, Leerzeichen, NBSP …).
    let s = String(raw).replace(/[^\d.,-]/g, '');
    if (!/\d/.test(s)) return null;
    const negative = s.startsWith('-');
    s = s.replace(/-/g, '');

    const lastComma = s.lastIndexOf(',');
    const lastDot = s.lastIndexOf('.');
    let decimalSep = null;

    if (lastComma !== -1 && lastDot !== -1) {
      // Beide vorhanden: das zuletzt stehende ist das Dezimaltrennzeichen.
      decimalSep = lastComma > lastDot ? ',' : '.';
    } else if (lastComma !== -1 || lastDot !== -1) {
      const sep = lastComma !== -1 ? ',' : '.';
      const parts = s.split(sep);
      const tail = parts[parts.length - 1];
      if (parts.length > 2) {
        decimalSep = null;               // "1.234.567" → nur Tausenderpunkte
      } else if (tail.length === 3 && parts[0] !== '' && parts[0] !== '0') {
        decimalSep = null;               // "1.234" / "1,234" → Tausender
      } else {
        decimalSep = sep;                // "113,23" / "0.5" → Dezimal
      }
    }

    let normalized;
    if (decimalSep) {
      const thousandSep = decimalSep === ',' ? '.' : ',';
      normalized = s.split(thousandSep).join('').replace(decimalSep, '.');
    } else {
      normalized = s.replace(/[.,]/g, '');
    }
    const value = parseFloat(normalized);
    if (!isFinite(value)) return null;
    return negative ? -value : value;
  }

  /** Rang eines Zustands: 0 = MT (bester) … 6 = PO. Unbekannt → Infinity. */
  function conditionRank(cond) {
    const i = CONDITIONS.indexOf(String(cond || '').toUpperCase());
    return i === -1 ? Infinity : i;
  }

  /** Bildet ein aria-label ("Englisch") auf einen Sprachcode ("en") ab. */
  function languageCodeFromLabel(label) {
    const l = String(label || '').trim().toLowerCase();
    const lang = LANGUAGES.find(x => x.names.includes(l));
    return lang ? lang.code : null;
  }

  /**
   * Anzahl Verkäufe aus dem Badge. Bevorzugt den Tooltip ("62774 Verkäufe | …"),
   * sonst den sichtbaren Kurztext ("62K" → 62000, Näherung).
   */
  function parseSales(el) {
    if (!el) return null;
    const tip = el.getAttribute('data-bs-original-title') || el.getAttribute('title') || el.getAttribute('aria-label') || '';
    const m = tip.match(/(\d[\d.,]*)/);
    if (m) return parseInt(m[1].replace(/[.,]/g, ''), 10);
    const short = text(el).match(/^(\d+)\s*([kK])?/);
    if (short) return parseInt(short[1], 10) * (short[2] ? 1000 : 1);
    return null;
  }

  // ---------------------------------------------------------------------------
  // Auslesen der Seite
  // ---------------------------------------------------------------------------

  /**
   * Liest Trendpreis und Durchschnittspreise aus der Info-Box.
   * Rückgabe: { trend, avg30, avg7, avg1 } (einzelne Werte können null sein)
   * oder null, wenn die Info-Box fehlt.
   */
  function parseMarket(doc) {
    doc = doc || document;
    const dl = doc.querySelector(SELECTORS.infoList);
    if (!dl) {
      warn('Info-Box nicht gefunden (Selektor "' + SELECTORS.infoList + '").');
      return null;
    }
    const result = { trend: null, avg30: null, avg7: null, avg1: null };
    dl.querySelectorAll(SELECTORS.infoLabel).forEach(dt => {
      const label = text(dt);
      const dd = dt.nextElementSibling;
      if (!dd) return;
      // Reihenfolge wichtig: "30" vor "1" prüfen (\b1\b passt nicht auf "30", aber sicher ist sicher).
      for (const field of ['trend', 'avg30', 'avg7', 'avg1']) {
        if (result[field] === null && LABEL_PATTERNS[field].test(label)) {
          result[field] = parsePrice(text(dd));
          break;
        }
      }
    });
    if (result.trend === null) warn('Trendpreis in der Info-Box nicht gefunden.');
    if (result.avg30 === null) warn('30-Tage-Durchschnitt in der Info-Box nicht gefunden.');
    return result;
  }

  /** Liest ein einzelnes Angebot aus einer Tabellenzeile. */
  function parseOfferRow(row) {
    const priceEl = row.querySelector(SELECTORS.price);
    const price = parsePrice(text(priceEl));
    if (price === null) {
      warn('Preis in Angebotszeile nicht gefunden (Selektor "' + SELECTORS.price + '").');
      return null;
    }

    // Attribut-Icons: Sprache, Foil, Signiert, Scan-Vorschau …
    let language = null, languageLabel = null, foil = false;
    const attributes = [];
    row.querySelectorAll(SELECTORS.attributeIcons).forEach(el => {
      const label = (el.getAttribute('aria-label') || '').trim();
      if (!label || label.startsWith('<')) return;   // Scan-Vorschau enthält HTML
      attributes.push(label);
      if (FOIL_PATTERN.test(label)) { foil = true; return; }
      if (!language) {
        const code = languageCodeFromLabel(label);
        if (code) { language = code; languageLabel = label; }
      }
    });
    if (!language) warn('Unbekannte Kartensprache in Angebot (Attribute: ' + attributes.join(', ') + ').');

    const locEl = row.querySelector(SELECTORS.sellerLocation);
    const locLabel = locEl ? locEl.getAttribute('aria-label') : '';
    const country = locLabel ? locLabel.split(LOCATION_SPLIT).pop().trim() : null;

    // Verkäufertyp: "pro" (gewerblich), "power" (Powerseller) oder "private"
    let sellerType = 'private';
    const typeEl = row.querySelector(SELECTORS.sellerTypeIcon);
    if (typeEl) {
      for (const cls in SELLER_TYPE_CLASSES) {
        if (typeEl.className.includes(cls)) sellerType = SELLER_TYPE_CLASSES[cls];
      }
    }

    const amountRaw = parseInt(text(row.querySelector(SELECTORS.amount)), 10);

    return {
      id: row.id || null,
      price,
      condition: text(row.querySelector(SELECTORS.condition)).toUpperCase() || null,
      language,
      languageLabel,
      foil,
      attributes,
      seller: text(row.querySelector(SELECTORS.sellerName)) || null,
      sellerType,
      sales: parseSales(row.querySelector(SELECTORS.sellerSales)),
      country,
      amount: isNaN(amountRaw) ? null : amountRaw
    };
  }

  /** Liefert alle Angebotszeilen der Seite (leer + Warnung, wenn keine). */
  function findOfferRows(doc) {
    doc = doc || document;
    const rows = Array.from(doc.querySelectorAll(SELECTORS.offerRow));
    if (rows.length === 0) warn('Keine Angebotszeilen gefunden (Selektor "' + SELECTORS.offerRow + '").');
    return rows;
  }

  /** Name der Karte aus der Überschrift (ohne Untertitel-Span), in Oberflächensprache. */
  function parseCardName(doc) {
    doc = doc || document;
    const h1 = doc.querySelector(SELECTORS.cardTitle);
    if (!h1) { warn('Kartenname nicht gefunden.'); return null; }
    const own = Array.from(h1.childNodes)
      .filter(n => n.nodeType === 3)          // nur direkte Textknoten
      .map(n => n.textContent).join('').trim();
    return own || text(h1);
  }

  /**
   * Pfad der Produktseite ohne Sprachpräfix und Query,
   * z. B. "/Magic/Products/Singles/Mirrodin/Chrome-Mox". Identifiziert einen Druck.
   */
  function productPath(doc, loc) {
    doc = doc || document;
    loc = loc || global.location;
    const canon = doc.querySelector(SELECTORS.canonicalLink);
    let path;
    try {
      path = new URL(canon ? canon.href : loc.href).pathname;
    } catch (e) {
      path = loc.pathname;
    }
    return path.replace(/^\/[a-z]{2}(?=\/)/i, '').replace(/\/+$/, '');
  }

  /** Cardmarket-Produkt-ID (idProduct) der Seite oder null. Identifiziert den Druck eindeutig. */
  function productId(doc) {
    doc = doc || document;
    const el = doc.querySelector(SELECTORS.productId);
    const id = el ? parseInt(el.value || el.getAttribute('value'), 10) : NaN;
    if (!Number.isInteger(id) || id <= 0) { warn('Produkt-ID nicht gefunden (Selektor "' + SELECTORS.productId + '").'); return null; }
    return id;
  }

  /** Artikel-ID aus der Zeilen-ID: "articleRow2176715000" → "2176715000". */
  function articleId(rowId) {
    const m = /(\d+)$/.exec(String(rowId || ''));
    return m ? m[1] : null;
  }

  /** Edition aus dem Produktpfad ("/Magic/Products/Singles/Mirrodin/Chrome-Mox" → "Mirrodin"). */
  function expansionFromPath(path) {
    const parts = String(path || '').split('/').filter(Boolean);
    return parts.length >= 2 ? decodeURIComponent(parts[parts.length - 2]).replace(/-/g, ' ') : null;
  }

  global.MTGParser = {
    SELECTORS, LABEL_PATTERNS, CONDITIONS, LANGUAGES,
    parsePrice, conditionRank, languageCodeFromLabel, parseSales,
    parseMarket, parseOfferRow, findOfferRows, parseCardName, productPath, expansionFromPath,
    productId, articleId, warn
  };
})(typeof window !== 'undefined' ? window : globalThis);
