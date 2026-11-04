import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { runPipeline } from '../src/services/pipeline.ts';
import { dispatchAlerts } from '../src/services/alerts.ts';
import { testApp, type TestApp } from './helpers.ts';

describe('REST-API', () => {
  let t: TestApp;
  let base = '';
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json: json as never, text };
  };
  const auth = () => ({ 'X-MTGDS-Token': t.token });

  before(async () => {
    t = testApp();
    await runPipeline(t.ctx, { scryfall: false });
    await new Promise<void>(r => t.server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(t.server.address() as AddressInfo).port}`;
  });
  after(async () => { await t.cleanup(); });

  it('Status zeigt Quellen, Zähler und ehrliche Warnungen', async () => {
    const r = await call('GET', '/api/status');
    assert.equal(r.status, 200);
    const j = r.json as { sources: { source: string; lastSuccessAt: string }[]; warnings: string[]; counts: { products: number } };
    assert.equal(j.counts.products, 4);
    assert.ok(j.sources.find(s => s.source === 'cardmarket_price_guide')?.lastSuccessAt);
    assert.ok(j.warnings.some(w => w.includes('Keine beobachteten Live-Angebote')));
  });

  it('Schreibzugriff ohne Token wird abgelehnt', async () => {
    const r = await call('POST', '/api/watchlist', { name: 'Chrome Mox' });
    assert.equal(r.status, 401);
  });

  it('Fremder Host-Header wird abgelehnt (DNS-Rebinding)', async () => {
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(base + '/api/status', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode ?? 0); });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  it('Token-Endpunkt nur für das eigene Dashboard', async () => {
    assert.equal((await call('GET', '/api/token')).status, 403);
    assert.equal((await call('GET', '/api/token', undefined, { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  });

  it('Extension-Angebote werden bewertet und als LIVE-ANGEBOT gekennzeichnet', async () => {
    const r = await call('POST', '/api/offers', {
      source: 'extension',
      offers: [
        { externalId: 'articleRow9', productExternalId: 152, price: 55, condition: 'NM', language: 'en', seller: 'GoodSeller', sellerCountry: 'Deutschland', sellerType: 'pro', sellerSales: 5000, observedAt: new Date().toISOString() },
        { externalId: 'articleRow10', productExternalId: 152, price: 85, condition: 'NM', language: 'en', seller: 'GoodSeller', sellerCountry: 'Deutschland' },
      ],
    }, auth());
    assert.equal(r.status, 200, r.text);
    const ev = (r.json as unknown as { evaluations: { index: number; recommendation: string; profitBase: number }[] }).evaluations;
    assert.equal(ev.length, 2);
    const cheap = ev.find(e => e.index === 0);
    const dear = ev.find(e => e.index === 1);
    assert.equal(cheap?.recommendation, 'KAUFEN');
    assert.equal(dear?.recommendation, 'NICHT KAUFEN');
    const alerts = await call('GET', '/api/alerts?kind=live_offer');
    const list = alerts.json as unknown as { signalClass: string; payload: { dataDate: string; observedAt: string; source: string } }[];
    assert.ok(list.length >= 1);
    assert.equal(list[0].signalClass, 'LIVE_OFFER');
    assert.ok(list[0].payload.dataDate && list[0].payload.observedAt && list[0].payload.source === 'extension');
  });

  it('Ungültige Angebote werden mit Begründung abgelehnt', async () => {
    const r = await call('POST', '/api/offers', { source: 'crawler', offers: [] }, auth());
    assert.equal(r.status, 400);
  });

  it('Alarme werden dedupliziert (Cooldown)', async () => {
    const a = { kind: 'anomaly' as const, signalClass: 'MARKET_SIGNAL' as const, priority: 'WATCH' as const, productId: null, dedupeKey: 'test:dup', title: 'x', message: 'y', payload: {} };
    const r1 = await dispatchAlerts(t.ctx, [a, a], {});
    const r2 = await dispatchAlerts(t.ctx, [a], {});
    assert.deepEqual(r1, { created: 1, suppressed: 1 });
    assert.deepEqual(r2, { created: 0, suppressed: 1 });
  });

  it('Externe Kanäle: Simulation nie, MARKET WATCH erst ab eingestellter Priorität, MEDIUM ja', async () => {
    t.ctx.settings.update({ alerts: { channels: { telegram: true } } });
    const sent: string[] = [];
    const sender = { telegram: async (txt: string) => { sent.push(txt); } };
    await dispatchAlerts(t.ctx, [
      { kind: 'live_offer', signalClass: 'SIMULATION', priority: null, productId: null, dedupeKey: 'sim:x', title: 'Sim', message: '', payload: {} },
      { kind: 'big_drop', signalClass: 'MARKET_SIGNAL', priority: 'WATCH', productId: null, dedupeKey: 'w:x', title: 'Watch', message: '', payload: {} },
      { kind: 'anomaly', signalClass: 'MARKET_SIGNAL', priority: 'MEDIUM', productId: null, dedupeKey: 'm:x', title: 'Markt', message: '', payload: { dataDate: '2026-11-04T02:47:21+01:00', source: 'cardmarket_price_guide' } },
    ], sender);
    t.ctx.settings.update({ alerts: { channels: { telegram: false } } });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /^\[MEDIUM PRIORITY · MARKTSIGNAL\]/);
    assert.match(sent[0], /Kein konkretes Angebot bekannt/);
    const watch = (await call('GET', '/api/alerts?priority=WATCH')).json as unknown as { deliveries: Record<string, string> }[];
    assert.match(watch[0].deliveries.extern, /nicht gesendet/);
  });

  it('Rangliste nach Analyse enthält das Live-Angebot; CSV-Export funktioniert', async () => {
    const an = await call('POST', '/api/analyze', {}, auth());
    assert.equal(an.status, 200, an.text);
    const r = await call('GET', '/api/opportunities?signalClass=LIVE_OFFER&sort=profit');
    const j = r.json as unknown as { total: number; items: { name: string; buy: { offerId: number } }[] };
    assert.ok(j.total >= 2, r.text.slice(0, 300));
    const res = await fetch(base + '/api/opportunities.csv');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="mtgds-opportunities-/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8-BOM für Excel');
    const text = new TextDecoder().decode(bytes);
    assert.ok(text.startsWith('Karte;Edition'));
    assert.ok(text.includes('Chrome Mox'));
  });

  it('Profit-Rechner mit Produktbezug', async () => {
    const r = await call('POST', '/api/calc', { buyPrice: 55, productId: 1, finish: 'nonfoil', condition: 'NM', language: 'en', sellerCountry: 'Deutschland' }, auth());
    assert.equal(r.status, 200, r.text);
    const j = r.json as unknown as { buyShipping: number; scenarios: { base: { profit: number } }; breakEvenSellPrice: number };
    assert.equal(j.buyShipping, 3.95);
    assert.ok(j.scenarios.base.profit > 0);
    assert.ok(j.breakEvenSellPrice > 58.95);
  });

  it('Einstellungen werden validiert', async () => {
    const bad = await call('PUT', '/api/settings', { rules: { minProfit: -3 } }, auth());
    assert.equal(bad.status, 400);
    const ok = await call('PUT', '/api/settings', { rules: { minProfit: 4 } }, auth());
    assert.equal(ok.status, 200);
    assert.equal((ok.json as unknown as { settings: { rules: { minProfit: number } } }).settings.rules.minProfit, 4);
    await call('PUT', '/api/settings', { rules: { minProfit: 5 } }, auth());
  });

  it('Gesamtablauf: Empfehlung → Einkauf → Wareneingang → Auftrag → Versand → realisierter Deckungsbeitrag', async () => {
    const opp = await call('GET', '/api/opportunities?recommendation=KAUFEN');
    const key = (opp.json as unknown as { items: { key: string }[] }).items[0].key;
    const d = await call('POST', '/api/decisions', { opportunityKey: key, decision: 'accepted' }, auth());
    assert.equal(d.status, 200, d.text);
    const poId = (d.json as unknown as { purchaseOrderId: number }).purchaseOrderId;
    const po = (await call('GET', `/api/purchases/${poId}`)).json as unknown as { status: string; lines: { id: number; unitPrice: number }[]; shippingCost: number };
    assert.equal(po.status, 'planned');
    assert.equal((await call('POST', `/api/purchases/lines/${po.lines[0].id}/receive`, { qty: 1 }, auth())).status, 409, 'geplanter Einkauf darf nicht eingehen');
    assert.equal((await call('POST', `/api/purchases/${poId}/status`, { status: 'paid' }, auth())).status, 200);
    const rec = await call('POST', `/api/purchases/lines/${po.lines[0].id}/receive`, { qty: 1, locationCode: 'a01' }, auth());
    assert.equal(rec.status, 200, rec.text);
    const order = await call('POST', '/api/orders', { externalOrderId: 'CM-1', buyer: 'B', lines: [{ productId: 1, condition: 'NM', language: 'en', qty: 1, unitPrice: 80 }] }, auth());
    assert.equal(order.status, 200, order.text);
    const oid = (order.json as unknown as { id: number }).id;
    assert.equal((await call('POST', `/api/orders/${oid}/status`, { status: 'checked' }, auth())).status, 409, 'ohne Zahlung nicht prüfbar');
    assert.equal((await call('POST', `/api/orders/${oid}/status`, { status: 'checked', paymentReceived: true }, auth())).status, 200);
    assert.equal((await call('POST', `/api/orders/${oid}/status`, { status: 'packed' }, auth())).status, 200);
    assert.equal((await call('POST', `/api/orders/${oid}/status`, { status: 'shipped' }, auth())).status, 400, 'Versandkosten müssen angegeben werden');
    const shipped = await call('POST', `/api/orders/${oid}/status`, { status: 'shipped', shippingCost: 0.55, packagingCost: 0, platformFee: 4 }, auth());
    assert.equal(shipped.status, 200, shipped.text);
    // 80 − 4 − 0,55 − (55 + 3,95) = 16,50 (Kleinunternehmer)
    assert.equal((shipped.json as unknown as { result: { contribution: number } }).result.contribution, 16.5);
    await call('POST', '/api/decisions', { opportunityKey: key, decision: 'rejected', reason: 'Test' }, auth());
    const v = (await call('GET', '/api/analytics/validation')).json as unknown as { overall: { accepted: number; rejected: number; successRatePct: number; unitsSold: number } };
    assert.deepEqual([v.overall.accepted, v.overall.rejected, v.overall.successRatePct, v.overall.unitsSold], [1, 1, 100, 1]);
    const p = (await call('GET', '/api/analytics/profit')).json as unknown as { kpis: { avgProfitPerCard: number; ordersTotal: number } };
    assert.equal(p.kpis.avgProfitPerCard, 16.5);
    assert.equal(p.kpis.ordersTotal, 1);
  });

  it('Simulation ist klar gekennzeichnet und löschbar', async () => {
    const r = await call('POST', '/api/simulation', { count: 3, seed: 1 }, auth());
    assert.equal(r.status, 200, r.text);
    const offers = (await call('GET', '/api/offers?includeSimulation=1')).json as unknown as { signalClass: string; source: string }[];
    assert.ok(offers.some(o => o.signalClass === 'SIMULATION' && o.source === 'simulation'));
    const live = (await call('GET', '/api/offers')).json as unknown as { signalClass: string }[];
    assert.ok(live.every(o => o.signalClass === 'LIVE_OFFER'));
    const del = await call('DELETE', '/api/simulation', undefined, auth());
    assert.ok((del.json as unknown as { deleted: number }).deleted >= 1);
  });
});
