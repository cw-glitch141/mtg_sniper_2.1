/**
 * REST-Endpunkte der Business Edition (2.1): Einkauf, Lager, Verkauf, Versand, Repricing, Kapital, Analytics.
 */
import { nowIso } from '../db/database.ts';
import type { AppContext } from '../services/context.ts';
import { profitAnalytics, strategyValidation } from '../services/businessAnalytics.ts';
import { addLedger, concentration, deleteLedger, listLedger, portfolioHistory, portfolioOverview } from '../services/portfolio.ts';
import {
  createPurchase, deletePurchase, getPurchase, listPurchases, receiveLine, setPurchaseStatus, updatePurchaseCosts, type PoStatus, type PurchaseInput,
} from '../services/purchases.ts';
import { applyPrice, repricingSuggestions } from '../services/repricing.ts';
import {
  archiveOrders, buildPicklist, createOrder, getOrder, importOrdersCsv, listOrders, reportMissing, resolveMissing, resolveProblem, returnItems,
  setOrderStatus, updateOrderDetails, type OrderInput, type StatusInput,
} from '../services/sales.ts';
import { adjustLot, createLot, ensureLocation, getLot, listLocations, lotCode, lotMovements, patchLot, queryLots, splitLot, toLotView, type ManualLotInput } from '../services/stock.ts';
import { ApiError, intParam, obj, optNum, Raw, type Router } from './http.ts';

const csvCell = (v: unknown) => {
  const s = v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
  return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const csv = (head: string[], rows: unknown[][], file: string) =>
  new Raw('text/csv; charset=utf-8', '﻿' + [head.join(';'), ...rows.map(r => r.map(csvCell).join(';'))].join('\r\n'), file);

export function registerBusinessRoutes(r: Router, ctx: AppContext): void {
  const { db } = ctx;
  const S = () => ctx.settings.get();
  const num = (v: unknown, name: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new ApiError(400, `${name} muss eine Zahl sein`);
    return v;
  };

  // ------------------------------------------------------------------ Kapital & Risiko
  r.get('/api/portfolio', () => ({
    overview: portfolioOverview(db, S()), concentration: concentration(db, S()),
    limits: { ...S().limits, maxCapitalPerCard: S().rules.maxCapitalPerCard, maxInventoryCapital: S().rules.maxInventoryCapital },
  }));
  r.get('/api/portfolio/history', c => portfolioHistory(db, optNum(c.query, 'days') ?? 365));
  r.get('/api/ledger', () => listLedger(db));
  r.post('/api/ledger', c => {
    const b = obj(c.body);
    return { id: addLedger(db, { type: String(b.type), amount: num(b.amount, 'amount'), bookedAt: (b.bookedAt as string) ?? null, category: (b.category as string) ?? null, note: (b.note as string) ?? null }) };
  });
  r.delete('/api/ledger/:id', c => { deleteLedger(db, intParam(c.params.id, 'id')); });

  // ------------------------------------------------------------------ Einkauf
  r.get('/api/purchases', c => listPurchases(db, { status: c.query.get('status') ?? undefined, open: c.query.get('open') === '1' }));
  r.get('/api/purchases/:id', c => getPurchase(db, intParam(c.params.id, 'id')));
  r.post('/api/purchases', c => ({ id: createPurchase(db, obj(c.body) as unknown as PurchaseInput) }));
  r.patch('/api/purchases/:id', c => { updatePurchaseCosts(db, intParam(c.params.id, 'id'), obj(c.body) as never); return getPurchase(db, intParam(c.params.id, 'id')); });
  r.post('/api/purchases/:id/status', c => {
    const b = obj(c.body);
    setPurchaseStatus(db, intParam(c.params.id, 'id'), String(b.status) as PoStatus, { note: (b.note as string) ?? null, refund: b.refund == null ? null : num(b.refund, 'refund'), at: (b.at as string) ?? null });
    return getPurchase(db, intParam(c.params.id, 'id'));
  });
  r.post('/api/purchases/lines/:lineId/receive', c => {
    const b = obj(c.body);
    const lotId = receiveLine(db, S(), intParam(c.params.lineId, 'lineId'), {
      qty: num(b.qty, 'qty'), locationCode: (b.locationCode as string) ?? null, condition: (b.condition as string) ?? null, language: (b.language as string) ?? null,
    });
    return { lotId, lotCode: lotCode(lotId) };
  });
  r.delete('/api/purchases/:id', c => { deletePurchase(db, intParam(c.params.id, 'id')); });

  // ------------------------------------------------------------------ Lager
  r.get('/api/lots', c => queryLots(db, S(), {
    q: c.query.get('q') ?? undefined, ownership: c.query.get('ownership') ?? undefined, status: c.query.get('status') ?? undefined,
    locationId: optNum(c.query, 'locationId'), productId: optNum(c.query, 'productId'), slowOnly: c.query.get('slow') === '1',
    limit: optNum(c.query, 'limit'), offset: optNum(c.query, 'offset'),
  }));
  r.get('/api/lots.csv', c => {
    const res = queryLots(db, S(), { ownership: c.query.get('ownership') ?? undefined, status: c.query.get('status') ?? 'onhand', limit: 2000 });
    return csv(['bestands_id', 'karte', 'edition', 'set', 'nr', 'cardmarket_id', 'finish', 'zustand', 'sprache', 'menge', 'reserviert', 'verfuegbar', 'einstand_stk',
      'nebenkosten_stk', 'einkaufsdatum', 'lagerplatz', 'verkaufsstatus', 'plattform', 'angebotspreis', 'erloes_realisiert'],
      res.items.map(l => [l.code, l.name, l.setName, l.setCode, l.collectorNumber, l.externalId, l.finish, l.condition, l.language, l.qtyOnHand, l.qtyReserved, l.qtyAvailable,
        l.unitCost, l.unitAlloc, l.acquiredAt, l.location, l.salesStatus, l.listPlatform, l.listPrice, l.realizedRevenue]), `mtgds-bestand-${nowIso().slice(0, 10)}.csv`);
  });
  r.get('/api/lots/:id', c => {
    const id = intParam(c.params.id, 'id');
    const lot = queryLots(db, S(), { q: lotCode(id), ownership: getLot(db, id).ownership, status: 'all', limit: 1 }).items[0];
    return { lot, movements: lotMovements(db, id) };
  });
  r.post('/api/lots', c => {
    const id = db.tx(() => createLot(db, S(), obj(c.body) as unknown as ManualLotInput));
    return toLotView(getLot(db, id), S());
  });
  r.patch('/api/lots/:id', c => { db.tx(() => patchLot(db, S(), intParam(c.params.id, 'id'), obj(c.body) as never)); return { ok: true }; });
  r.post('/api/lots/:id/adjust', c => {
    const b = obj(c.body);
    db.tx(() => adjustLot(db, intParam(c.params.id, 'id'), num(b.delta, 'delta'), String(b.reason ?? '')));
    return { ok: true };
  });
  r.post('/api/lots/:id/split', c => {
    const b = obj(c.body);
    const newId = db.tx(() => splitLot(db, S(), intParam(c.params.id, 'id'), num(b.qty, 'qty'), {
      locationCode: b.locationCode as string | undefined, ownership: b.ownership as 'business' | 'private' | undefined, privateDeck: (b.privateDeck as string) ?? null,
    }));
    return { lotId: newId, lotCode: lotCode(newId) };
  });
  r.get('/api/locations', () => listLocations(db));
  r.post('/api/locations', c => {
    const b = obj(c.body);
    const codes = Array.isArray(b.codes) ? (b.codes as string[]) : [String(b.code ?? '')];
    return { ids: db.tx(() => codes.map(code => ensureLocation(db, S(), code, (b.warehouse as string) ?? null))) };
  });

  // ------------------------------------------------------------------ Repricing
  r.get('/api/repricing', c => repricingSuggestions(db, S(), { onlyActionable: c.query.get('actionable') === '1' }));
  r.get('/api/repricing.csv', () => {
    const rows = repricingSuggestions(db, S(), { onlyActionable: true }).filter(x => x.suggested != null);
    return csv(['bestands_id', 'karte', 'edition', 'zustand', 'sprache', 'finish', 'menge', 'aktueller_preis', 'vorschlag', 'untergrenze', 'marktwert', 'grund'],
      rows.map(x => [x.lotCode, x.name, x.setName, x.condition, x.language, x.finish, x.qtyAvailable, x.listPrice, x.suggested, x.floor, x.marketBase, x.actionLabel]),
      `mtgds-preisvorschlaege-${nowIso().slice(0, 10)}.csv`);
  });
  r.post('/api/repricing/apply', c => {
    const b = obj(c.body);
    if (!Array.isArray(b.items)) throw new ApiError(400, 'items: Liste erwartet');
    const errors: { lotId: number; error: string }[] = [];
    let applied = 0;
    for (const it of b.items as { lotId: number; price: number; acceptBelowFloor?: boolean }[]) {
      try { db.tx(() => applyPrice(db, S(), it.lotId, it.price, it.acceptBelowFloor === true)); applied++; }
      catch (e) { errors.push({ lotId: it.lotId, error: (e as Error).message }); }
    }
    return { applied, errors };
  });

  // ------------------------------------------------------------------ Verkaufsaufträge & Versand
  r.get('/api/orders', c => listOrders(db, S(), {
    status: c.query.get('status') ?? undefined, active: c.query.get('active') === '1', archived: c.query.get('archived') === '1', q: c.query.get('q') ?? undefined,
    limit: optNum(c.query, 'limit'), offset: optNum(c.query, 'offset'),
  }));
  r.get('/api/orders/:id', c => getOrder(db, S(), intParam(c.params.id, 'id')));
  r.post('/api/orders', c => ({ id: createOrder(db, obj(c.body) as unknown as OrderInput) }));
  r.post('/api/orders/import', c => {
    const b = obj(c.body);
    const text = typeof b.csv === 'string' ? b.csv : typeof b.text === 'string' ? b.text : null;
    if (!text) throw new ApiError(400, 'CSV fehlt (Feld "csv")');
    return importOrdersCsv(db, text);
  });
  r.patch('/api/orders/:id', c => { updateOrderDetails(db, intParam(c.params.id, 'id'), obj(c.body) as never); return getOrder(db, S(), intParam(c.params.id, 'id')); });
  r.post('/api/orders/:id/status', c => { setOrderStatus(db, intParam(c.params.id, 'id'), obj(c.body) as unknown as StatusInput); return getOrder(db, S(), intParam(c.params.id, 'id')); });
  r.post('/api/orders/:id/resolve', c => { resolveProblem(db, intParam(c.params.id, 'id')); return getOrder(db, S(), intParam(c.params.id, 'id')); });
  r.post('/api/orders/:id/return', c => {
    const b = obj(c.body);
    if (!Array.isArray(b.items)) throw new ApiError(400, 'items: Liste erwartet');
    returnItems(db, intParam(c.params.id, 'id'), b.items as { lineId: number; qty: number; restock: boolean }[], num(b.refund ?? 0, 'refund'));
    return getOrder(db, S(), intParam(c.params.id, 'id'));
  });
  r.post('/api/orders/lines/:lineId/missing', c => {
    const b = obj(c.body);
    reportMissing(db, intParam(c.params.lineId, 'lineId'), num(b.qty ?? 1, 'qty'), (b.lotId as number) ?? null);
    return { ok: true };
  });
  r.post('/api/orders/lines/:lineId/resolve-missing', c => {
    const b = obj(c.body);
    if (b.mode !== 'reallocate' && b.mode !== 'drop') throw new ApiError(400, 'mode: reallocate | drop');
    resolveMissing(db, intParam(c.params.lineId, 'lineId'), b.mode);
    return { ok: true };
  });
  r.post('/api/orders/archive', c => {
    const b = obj(c.body);
    return { archived: archiveOrders(db, S(), Array.isArray(b.ids) ? (b.ids as number[]) : undefined) };
  });
  r.post('/api/picklist', c => {
    const b = obj(c.body);
    if (!Array.isArray(b.orderIds)) throw new ApiError(400, 'orderIds: Liste erwartet');
    return db.tx(() => buildPicklist(db, b.orderIds as number[], b.markPicking !== false));
  });
  r.get('/api/orders.csv', c => {
    const res = listOrders(db, S(), { archived: c.query.get('archived') === '1', limit: 1000 });
    return csv(['auftrag', 'plattform', 'auftragsnr', 'kaeufer', 'status', 'zahlung', 'bestellt', 'versendet', 'karten', 'warenwert', 'porto_kaeufer', 'umsatz', 'deckungsbeitrag', 'tracking'],
      res.items.map(o => [o.id, o.platform, o.externalOrderId, o.buyer, o.status, o.paymentStatus, o.orderedAt.slice(0, 10), o.shippedAt?.slice(0, 10), o.units,
        o.itemsValue, o.shippingCharged, o.result?.revenueGross, o.result?.contribution, o.trackingNumber]), `mtgds-auftraege-${nowIso().slice(0, 10)}.csv`);
  });

  // ------------------------------------------------------------------ Analytics
  r.get('/api/analytics/profit', () => profitAnalytics(db, S()));
  r.get('/api/analytics/validation', () => strategyValidation(db, S()));
}
