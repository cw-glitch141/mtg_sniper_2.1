import { useState } from 'react';
import { api, type Decision, type ProfitAnalytics, type Validation, type ValidationGroup } from '../api';
import { SeriesChart } from '../components/SeriesChart';
import { date, euro, int, num, pct, STRATEGY_LABEL } from '../format';
import { Empty, ErrorNotice, Money, PriorityBadge, SignalBadge, useAsync } from '../ui';

function GroupTable({ title, rows, label = (g: string) => g }: { title: string; rows: ValidationGroup[]; label?: (g: string) => string }) {
  if (!rows.length) return null;
  return (
    <div className="card">
      <div className="card-head"><h3>{title}</h3></div>
      <table className="compact">
        <thead><tr><th>Gruppe</th><th className="num">Entsch.</th><th className="num">Gekauft</th><th className="num">Verkauft</th><th className="num">Abverkauf</th><th className="num">Ø Tage</th><th className="num">DB/Karte</th><th className="num">Verlust</th><th className="num">Gebunden</th></tr></thead>
        <tbody>{rows.map(g => (
          <tr key={g.group} style={{ opacity: g.insufficient ? 0.6 : 1 }} title={g.insufficient ? 'Zu wenige Daten – keine Schlüsse ziehen' : undefined}>
            <td>{label(g.group)}{g.insufficient && <span className="muted small"> (n&lt;10)</span>}</td><td className="num">{g.decisions}</td><td className="num">{g.unitsBought}</td><td className="num">{g.unitsSold}</td>
            <td className="num">{pct(g.sellThroughPct)}</td><td className="num">{num(g.avgDaysToSell)}</td><td className="num"><Money v={g.contributionPerUnit} signed /></td>
            <td className="num">{g.lossDecisions}</td><td className="num">{euro(g.boundCapital)}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function ValidationView() {
  const { data, error } = useAsync(() => api.get<Validation>('/api/analytics/validation'), []);
  if (error) return <ErrorNotice error={error} />;
  if (!data) return null;
  const o = data.overall;
  return (
    <>
      <div className="notice info small">{data.note}</div>
      <div className="tiles">
        <div className="card tile"><div className="label">Protokollierte Empfehlungen</div><div className="value">{int(o.recommendationsLogged)}</div><div className="hint">KAUFEN/PRÜFEN, je Deal einmal</div></div>
        <div className="card tile"><div className="label">Gekauft / abgelehnt</div><div className="value">{o.accepted} / {o.rejected}</div><div className="hint">Kaufquote {pct(o.boughtSharePct)}</div></div>
        <div className="card tile"><div className="label">Verkauft</div><div className="value">{o.unitsSold} / {o.unitsBought}</div><div className="hint">Karten aus angenommenen Empfehlungen</div></div>
        <div className="card tile"><div className="label">Erfolgsquote</div><div className="value">{pct(o.successRatePct)}</div><div className="hint">Entscheidungen mit positivem DB (n = {o.decisionsWithSales})</div></div>
        <div className="card tile"><div className="label">Prognosefehler je Karte</div><div className="value"><Money v={o.meanPredictionErrorPerUnit} signed /></div><div className="hint">realisiert − erwartet</div></div>
        <div className="card tile"><div className="label">Noch gebunden</div><div className="value">{euro(o.boundCapital)}</div><div className="hint">aus gekauften Empfehlungen</div></div>
      </div>
      {o.decisionsWithSales === 0 ? <Empty>Noch keine verkauften Karten aus Empfehlungen – die Auswertung füllt sich mit echten Verkäufen.</Empty> : (
        <>
          <div className="grid cols-2" style={{ marginBottom: 16 }}>
            <GroupTable title="Nach Strategie" rows={data.byStrategy} label={g => STRATEGY_LABEL[g] ?? g} />
            <GroupTable title="Nach Preisbereich (Einkauf)" rows={data.byPriceBand} />
            <GroupTable title="Nach Priorität" rows={data.byPriority} />
            <GroupTable title="Nach Seltenheit" rows={data.byRarity} />
            <GroupTable title="Nach Score" rows={data.byScoreBand} />
            <GroupTable title="Nach Confidence" rows={data.byConfidenceBand} />
          </div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><h3>Welche Filter hätten die Wirtschaftlichkeit verbessert?</h3><span className="small muted">nachträglich auf reale Verkäufe angewandt</span></div>
            <table className="compact"><thead><tr><th>Filter</th><th className="num">ab</th><th className="num">Entscheidungen</th><th className="num">DB je Karte</th><th className="num">Verlustquote</th></tr></thead>
              <tbody>{data.filterTests.map((f, i) => (
                <tr key={i} style={{ opacity: f.insufficient ? 0.6 : 1 }}><td>{f.filter}</td><td className="num">{f.threshold}</td><td className="num">{f.decisions}{f.insufficient ? ' (n<10)' : ''}</td>
                  <td className="num"><Money v={f.contributionPerUnit} signed /></td><td className="num">{pct(f.lossSharePct)}</td></tr>
              ))}</tbody></table>
          </div>
          {data.lossMakers.length > 0 && <div className="card"><div className="card-head"><h3>Empfehlungen mit Verlust</h3></div>
            <table className="compact"><tbody>{data.lossMakers.map(l => <tr key={l.decisionId}><td>{l.name}<span className="muted small"> {l.setName}</span></td><td>{STRATEGY_LABEL[l.strategy] ?? l.strategy}</td><td className="num">{l.unitsSold} verkauft</td><td className="num"><Money v={l.contribution} signed /></td></tr>)}</tbody></table></div>}
        </>
      )}
    </>
  );
}

function Decisions() {
  const { data } = useAsync(() => api.get<Decision[]>('/api/decisions'), []);
  if (!data) return null;
  if (!data.length) return <Empty>Noch keine Entscheidungen protokolliert.</Empty>;
  return (
    <div className="table-wrap"><table className="compact">
      <thead><tr><th>Datum</th><th>Entscheidung</th><th>Karte</th><th>Signal</th><th>Priorität</th><th>Strategie</th><th className="num">Score</th><th className="num">Einkauf</th><th className="num">Erw. Gewinn</th><th className="num">Trend heute</th><th className="num">ggü. Einkauf</th><th>Grund</th></tr></thead>
      <tbody>{data.map(x => (
        <tr key={x.id}><td>{date(x.createdAt)}</td><td className={x.decision === 'accepted' ? 'pos' : 'muted'}>{x.decision === 'accepted' ? `gekauft${x.purchaseOrderId ? ' (#' + x.purchaseOrderId + ')' : ''}` : 'abgelehnt'}</td>
          <td>{x.name}<div className="small muted">{x.setName}</div></td><td><SignalBadge c={x.signalClass as 'LIVE_OFFER'} /></td><td><PriorityBadge p={x.priority as 'HIGH'} /></td>
          <td className="small">{STRATEGY_LABEL[x.strategy] ?? x.strategy}</td><td className="num">{Math.round(x.score)}</td><td className="num">{euro(x.buyPrice)}</td><td className="num">{euro(x.expectedProfitBase)}</td>
          <td className="num">{euro(x.currentTrend)}</td><td className={`num ${(x.trendVsBuyPct ?? 0) >= 0 ? 'pos' : 'neg'}`}>{pct(x.trendVsBuyPct, true)}</td><td className="small wrap">{x.reason ?? ''}</td></tr>
      ))}</tbody>
    </table></div>
  );
}

export function Analytics() {
  const [tab, setTab] = useState<'profit' | 'validation' | 'decisions'>('profit');
  const { data, error } = useAsync(() => api.get<ProfitAnalytics>('/api/analytics/profit'), []);
  const k = data?.kpis;
  return (
    <>
      <div className="page-head"><h1>Profit Analytics</h1><span className="sub">{data?.basis}</span></div>
      <div className="tabs">{([['profit', 'Ergebnis & Kennzahlen'], ['validation', 'Strategievalidierung'], ['decisions', 'Entscheidungsprotokoll']] as const).map(([t, l]) => (
        <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>{l}</button>))}</div>
      <ErrorNotice error={error} />
      {tab === 'profit' && data && k && (
        <>
          <div className="tiles">
            <div className="card tile"><div className="label">Umsatz (Monat)</div><div className="value">{euro(k.monthRevenue)}</div></div>
            <div className="card tile"><div className="label">Deckungsbeitrag (Monat)</div><div className="value"><Money v={k.monthContribution} signed /></div></div>
            <div className="card tile"><div className="label">Verkaufsvolumen</div><div className="value">{int(k.salesUnitsTotal)}</div><div className="hint">{int(k.ordersTotal)} Aufträge</div></div>
            <div className="card tile"><div className="label">Ø Gewinn je Karte</div><div className="value">{euro(k.avgProfitPerCard)}</div><div className="hint">je Auftrag {euro(k.avgProfitPerOrder)}</div></div>
            <div className="card tile"><div className="label">Gewinn je Arbeitsstunde</div><div className="value">{euro(k.profitPerLaborHour)}</div><div className="hint">DB − Kosten / kalk. Stunden</div></div>
            <div className="card tile"><div className="label">Ø Lagerdauer</div><div className="value">{k.avgStorageDays == null ? '–' : num(k.avgStorageDays) + ' T.'}</div><div className="hint">Umschlag {k.inventoryTurnover == null ? '–' : num(k.inventoryTurnover, 2) + '×'}/Jahr</div></div>
            <div className="card tile"><div className="label">Kapitalbindung</div><div className="value">{euro(k.capitalBound)}</div><div className="hint">{int(k.currentStockUnits)} Karten im Bestand</div></div>
            <div className="card tile"><div className="label">Offene Aufträge</div><div className="value">{int(k.openOrders)}</div><div className="hint">Retourenquote {pct(k.returnRatePct)}</div></div>
            <div className="card tile"><div className="label">Erfolgsquote Empfehlungen</div><div className="value">{pct(k.recommendationSuccessPct)}</div><div className="hint">n = {k.recommendationSample}</div></div>
            <div className="card tile kpi-forecast"><div className="label">Erwartete Erlöse Bestand</div><div className="value">{euro(data.forecast.expectedProceeds.value)}</div><div className="hint">nicht realisiert</div></div>
          </div>
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-head"><h2>Monatsverlauf (realisiert)</h2></div>
            <SeriesChart data={data.monthly} x="month" kind="bar" series={[{ key: 'revenueGross', label: 'Umsatz' }, { key: 'contribution', label: 'Deckungsbeitrag' }]} empty="Noch keine versendeten Aufträge." />
          </div>
          {data.monthly.length > 0 && (
            <div className="card">
              <div className="card-head"><h2>Umsatz, Gewinn, Steuer und Geldfluss je Monat</h2></div>
              <div className="table-wrap"><table className="compact">
                <thead><tr><th>Monat</th><th className="num">Aufträge</th><th className="num">Karten</th><th className="num">Umsatz</th><th className="num">Nettoerlös</th><th className="num">Wareneinsatz</th>
                  <th className="num">DB</th><th className="num">Kosten</th><th className="num">Gewinn v. St.</th><th className="num">USt-Zahllast</th><th className="num">Std.</th><th className="num">€/Std.</th>
                  <th className="num">Einzahl.</th><th className="num">Auszahl.</th><th className="num">Netto-Cashflow</th></tr></thead>
                <tbody>{data.monthly.map(m => (
                  <tr key={m.month}><td>{m.month}</td><td className="num">{m.orders}</td><td className="num">{m.units}</td><td className="num">{euro(m.revenueGross)}</td><td className="num">{euro(m.netRevenue)}</td>
                    <td className="num">{euro(m.cogs)}</td><td className="num"><Money v={m.contribution} signed /></td><td className="num">{euro(m.expenses)}</td><td className="num"><Money v={m.profitBeforeTax} signed /></td>
                    <td className="num">{euro(m.vatLiability)}</td><td className="num">{num(m.laborHours)}</td><td className="num">{euro(m.profitPerHour)}</td>
                    <td className="num">{euro(m.cashIn)}</td><td className="num">{euro(m.cashOut)}</td><td className="num"><Money v={m.netCashFlow} signed /></td></tr>
                ))}</tbody>
              </table></div>
              <p className="small muted">Umsatz ≠ Deckungsbeitrag ≠ Gewinn vor Steuern ≠ Geldfluss: Einkäufe werden beim Bezahlen als Auszahlung gebucht, als Wareneinsatz erst beim Verkauf. Einkommensteuer wird nicht berechnet.</p>
            </div>
          )}
        </>
      )}
      {tab === 'validation' && <ValidationView />}
      {tab === 'decisions' && <Decisions />}
    </>
  );
}
