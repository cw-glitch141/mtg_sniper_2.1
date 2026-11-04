/**
 * Entscheidungsprotokoll: jede angenommene oder abgelehnte Empfehlung mit damaliger Bewertung.
 * (Seit 2.1 erzeugt eine angenommene Empfehlung einen geplanten Einkauf statt eines Journal-Postens.)
 */
import { nowIso, parseJson, type Db } from '../db/database.ts';
import type { Opportunity } from '../analytics/opportunity.ts';
import { round2 } from '../util/num.ts';

export function recordDecision(db: Db, input: { opportunity: Opportunity; decision: 'accepted' | 'rejected'; reason?: string | null }): number {
  const o = input.opportunity;
  return db.run(`INSERT INTO decisions (created_at, opportunity_key, product_id, signal_class, strategy, decision, reason, score, confidence,
      buy_price, expected_sell_base, expected_profit_base, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [nowIso(), o.key, o.productId, o.signalClass, o.strategy, input.decision, input.reason ?? null, o.score.score, o.score.confidence,
      o.buy.effective, o.resale.base, o.scenarios.base?.profit ?? null, JSON.stringify(o)]).lastInsertRowid;
}

export function listDecisions(db: Db, limit = 200) {
  return db.all<Record<string, unknown>>(`
    SELECT d.id, d.created_at, d.opportunity_key, d.product_id, d.signal_class, d.strategy, d.decision, d.reason, d.score, d.confidence,
           d.buy_price, d.expected_sell_base, d.expected_profit_base, d.purchase_line_id, d.payload, l.trend AS current_trend, l.source_created_at AS current_date,
           pl.po_id
    FROM decisions d
    LEFT JOIN price_latest l ON l.product_id = d.product_id AND l.source = 'cardmarket_price_guide' AND l.finish = COALESCE(json_extract(d.payload, '$.finish'), 'nonfoil')
    LEFT JOIN purchase_lines pl ON pl.id = d.purchase_line_id
    ORDER BY d.id DESC LIMIT ?`, [limit]).map(r => {
    const o = parseJson<Opportunity | null>(r.payload, null);
    return {
      id: r.id, createdAt: r.created_at, opportunityKey: r.opportunity_key, productId: r.product_id, signalClass: r.signal_class, strategy: r.strategy,
      decision: r.decision, reason: r.reason, score: r.score, confidence: r.confidence, buyPrice: r.buy_price,
      expectedSellBase: r.expected_sell_base, expectedProfitBase: r.expected_profit_base, purchaseLineId: r.purchase_line_id, purchaseOrderId: r.po_id ?? null,
      priority: o?.priority ?? null, name: o?.name ?? null, setName: o?.setName ?? null, finish: o?.finish ?? null,
      // Nachträgliche Prüfung: aktueller Trend ggü. damaligem Einkauf (Indikator, kein realisierter Gewinn)
      currentTrend: r.current_trend, currentDataDate: r.current_date,
      trendVsBuyPct: r.current_trend != null && typeof r.buy_price === 'number' && r.buy_price > 0
        ? round2(((r.current_trend as number) - (r.buy_price as number)) / (r.buy_price as number) * 100) : null,
    };
  });
}
