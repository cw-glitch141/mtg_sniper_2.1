import { Fragment, useEffect, useMemo, useState } from 'react';
import { api, type Opportunity, type ProductDetail, type TradeResult } from '../api';
import { age, dateTime, euro, LANG_LABEL, num, pct, STRATEGY_LABEL } from '../format';
import { ErrorNotice, ExtraLabels, Money, NumInput, PriorityBadge, Rec, Score, SignalBadge, useAsync, useToast } from '../ui';
import { PriceChart } from './PriceChart';

const COMPONENT_LABEL: Record<string, string> = {
  profit: 'Nettoertrag/ROI', liquidity: 'Liquidität (Proxy)', deviation: 'Preisabweichung', stability: 'Stabilität', dataQuality: 'Datenqualität', risk: 'Risiko (100 = gering)',
};

function ScenarioTable({ o }: { o: Opportunity }) {
  const [open, setOpen] = useState(false);
  const sc: [string, TradeResult | null][] = [['Konservativ', o.scenarios.conservative], ['Basis', o.scenarios.base], ['Optimistisch', o.scenarios.optimistic]];
  const base = o.scenarios.base;
  return (
    <>
      <div className="table-wrap">
        <table className="compact">
          <thead><tr><th>Szenario</th><th className="num">Verkauf</th><th className="num">Kosten gesamt</th><th className="num">Gewinn</th><th className="num">ROI</th><th className="num">Marge</th></tr></thead>
          <tbody>{sc.map(([label, r]) => (
            <tr key={label}><td>{label}{label === 'Optimistisch' && <span className="muted small"> (nicht garantiert)</span>}</td>
              <td className="num">{euro(r?.sellPrice)}</td><td className="num">{euro(r?.totalCosts)}</td>
              <td className="num"><Money v={r?.profit} signed /></td><td className="num">{pct(r?.roiPct)}</td><td className="num">{pct(r?.marginPct)}</td></tr>
          ))}</tbody>
        </table>
      </div>
      <div className="row small" style={{ marginTop: 8 }}>
        <span>Break-even-Verkaufspreis: <strong>{euro(o.breakEvenSellPrice)}</strong></span>
        <span>· Max. Einkaufspreis (Basis, Regeln): <strong>{euro(o.maxBuyPrice)}</strong></span>
        <span>· Kapitalbedarf: <strong>{euro(o.buy.capital)}</strong></span>
        <button className="btn link small" onClick={() => setOpen(v => !v)}>{open ? 'Rechenweg ausblenden' : 'Rechenweg (Basis) anzeigen'}</button>
      </div>
      {open && base && (
        <div className="table-wrap" style={{ marginTop: 8 }}>
          <table className="compact">
            <tbody>
              {base.lines.map(l => <tr key={l.key}><td>{l.label}{l.note && <span className="muted small"> – {l.note}</span>}</td><td className="num"><Money v={l.amount} signed /></td></tr>)}
              <tr><td><strong>Deckungsbeitrag (vor Ertragsteuern)</strong></td><td className="num"><strong><Money v={base.profit} signed /></strong></td></tr>
            </tbody>
          </table>
          {base.warnings.map(w => <div key={w} className="notice warn" style={{ margin: 8 }}>{w}</div>)}
        </div>
      )}
    </>
  );
}

function OpportunityView({ o, onDecided }: { o: Opportunity; onDecided: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'none' | 'buy' | 'reject'>('none');
  const [qty, setQty] = useState<number | null>(1);
  const [buyPrice, setBuyPrice] = useState<number | null>(o.buy.price);
  const [shipping, setShipping] = useState<number | null>(o.buy.shipping);
  const [reason, setReason] = useState('');
  const [poStatus, setPoStatus] = useState<'planned' | 'ordered' | 'paid'>('ordered');
  const [confirmed, setConfirmed] = useState(false);
  const [showModel, setShowModel] = useState(false);
  const isMarket = o.signalClass === 'MARKET_SIGNAL';
  const submit = async (decision: 'accepted' | 'rejected') => {
    try {
      const body = decision === 'accepted'
        ? { opportunityKey: o.key, decision, confirmedAvailable: confirmed, purchase: { qty: qty ?? 1, unitPrice: buyPrice ?? o.buy.price, shippingCost: shipping ?? 0, status: poStatus } }
        : { opportunityKey: o.key, decision, reason: reason || null };
      const r = await api.post<{ purchaseOrderId: number | null }>('/api/decisions', body);
      toast(decision === 'accepted' ? `Einkauf #${r.purchaseOrderId} angelegt – Wareneingang im Purchase Manager buchen.` : 'Ablehnung protokolliert.');
      setMode('none');
      onDecided();
    } catch (e) { toast((e as Error).message, true); }
  };
  return (
    <div className="card section">
      <div className="row" style={{ marginBottom: 10 }}>
        <SignalBadge c={o.signalClass} />
        <ExtraLabels labels={o.labels} />
        <PriorityBadge p={o.priority} />
        <strong>{STRATEGY_LABEL[o.strategy]}</strong>
        {o.holdings && o.holdings.copies + o.holdings.onOrder > 0 && <span className="small muted">Bestand: {o.holdings.copies} im Lager, {o.holdings.onOrder} bestellt</span>}
        <Rec r={o.recommendation} />
        <span className="spacer" />
        <Score v={o.score.score} /> <span className="small muted">Confidence {Math.round(o.score.confidence)}</span>
      </div>
      {o.signalClass === 'MARKET_SIGNAL' && <div className="notice info">Marktsignal aus dem Cardmarket Price Guide (Stand {dateTime(o.dataDate)}). Es ist <strong>kein konkretes Angebot</strong> bekannt – bitte vor einem Kauf auf Cardmarket ein passendes Angebot suchen und prüfen.</div>}
      {o.signalClass === 'SIMULATION' && <div className="notice warn">SIMULATION – Testdaten ohne Kaufmöglichkeit.</div>}
      {o.stale && <div className="notice error">VERALTET: {o.staleReason}. Vor einer Entscheidung neu prüfen.</div>}
      {!isMarket && o.listingCheck && (o.listingCheck.missing.length > 0 || o.listingCheck.review.length > 0) && (
        <div className="notice warn">
          {o.listingCheck.missing.length > 0 && <div>Pflichtangaben fehlen: {o.listingCheck.missing.join(', ')} – daher nur Prüfung, keine Kaufchance.</div>}
          {o.listingCheck.review.length > 0 && <div>Vor Kauf prüfen: {o.listingCheck.review.join(', ')}</div>}
        </div>
      )}
      <div className="grid cols-2">
        {isMarket ? (
          <dl className="kv">
            <dt>Trend</dt><dd>{euro(o.guide?.trend)}</dd>
            <dt>Ø 1 / 7 / 30 Tage</dt><dd>{euro(o.guide?.avg1)} / {euro(o.guide?.avg7)} / {euro(o.guide?.avg30)}</dd>
            <dt>Tiefstpreis (gemeldet)</dt><dd>{euro(o.guide?.low)} <span className="muted small">(Zustand, Sprache, Verfügbarkeit unbekannt)</span></dd>
            <dt>Modellwert</dt><dd>{euro(o.buy.price)} <span className="muted small">hypothetisch – {o.buy.label.replace(/^Modellwert \(hypothetisch\):\s*/, '')}</span></dd>
            <dt>Datenstand</dt><dd>{dateTime(o.buy.observedAt)} <span className="muted small">({age(o.buy.observedAt)}, Quelle {o.buy.source})</span></dd>
          </dl>
        ) : (
          <dl className="kv">
            <dt>Angebot</dt><dd>{o.buy.label}{o.buy.externalId ? <span className="muted small"> · Angebots-ID {o.buy.externalId}</span> : null}</dd>
            <dt>Preis</dt><dd>{euro(o.buy.price)} + {euro(o.buy.shipping)} Porto <span className="muted small">({o.buy.shippingNote})</span></dd>
            <dt>Effektiv</dt><dd><strong>{euro(o.buy.effective)}</strong>{o.buy.previousPrice != null && <span className="muted small"> (vorher {euro(o.buy.previousPrice)})</span>}</dd>
            {o.buy.condition && <><dt>Zustand / Sprache</dt><dd>{o.buy.condition === 'MIX' ? 'Zustandsmix (Aggregat)' : o.buy.condition}{o.buy.language ? ' · ' + (LANG_LABEL[o.buy.language] ?? o.buy.language) : ''}</dd></>}
            {o.buy.seller && <><dt>Verkäufer</dt><dd>{o.buy.seller}{o.buy.sellerCountry ? ` (${o.buy.sellerCountry})` : ''}{o.buy.sellerSales != null ? ` · ${o.buy.sellerSales} Verkäufe` : ''}</dd></>}
            <dt>Beobachtet</dt><dd>{dateTime(o.buy.observedAt)} <span className="muted small">({age(o.buy.observedAt)}, Quelle {o.buy.source})</span></dd>
          </dl>
        )}
        <dl className="kv">
          <dt>Referenz (Median)</dt><dd>{euro(o.referencePrice)}</dd>
          <dt>Rabatt</dt><dd>{pct(o.discountPct)}</dd>
          <dt>Verkauf konservativ</dt><dd>{euro(o.resale.conservative)}</dd>
          <dt>Verkauf Basis</dt><dd>{euro(o.resale.base)}</dd>
          <dt>Verkauf optimistisch</dt><dd>{euro(o.resale.optimistic)}</dd>
          <dt>Faktoren</dt><dd className="small">Zustand {o.resale.conditionFactor} · Sprache {o.resale.languageFactor}</dd>
        </dl>
      </div>
      {isMarket ? (
        <div className="section">
          <button className="btn link small" onClick={() => setShowModel(v => !v)}>{showModel ? 'Hypothetische Rechnung ausblenden' : 'Hypothetische Rechnung anzeigen (kein Angebot, kein belegter Gewinn)'}</button>
          {showModel && <><div className="notice info" style={{ margin: '8px 0' }}>Rechnung unter der Annahme, man könnte zum Modellwert kaufen. Dazu ist kein Angebot belegt – die Zahlen sind keine Kauf- oder Gewinnaussage.</div><ScenarioTable o={o} /></>}
        </div>
      ) : <div className="section"><h3>Kalkulation</h3><ScenarioTable o={o} /></div>}
      <div className="grid cols-2 section">
        <div>
          <h3 style={{ marginBottom: 8 }}>Kaufregeln {o.rules.smallProfitMode && <span className="badge LIVE_OFFER">Small-Profit</span>}</h3>
          <ul className="checks">{o.rules.checks.map(c => <li key={c.rule} className={c.ok ? 'ok' : 'fail'} data-mark={c.ok ? '✓' : '✗'}><strong>{c.rule}:</strong> {c.detail}</li>)}</ul>
        </div>
        <div>
          <h3 style={{ marginBottom: 8 }}>Score-Komponenten</h3>
          <table className="compact"><tbody>
            {Object.entries(o.score.components).map(([k, c]) => (
              <tr key={k}><td>{COMPONENT_LABEL[k] ?? k}</td><td className="num">{num(c.value, 0)}</td><td className="small muted wrap">{c.note}</td></tr>
            ))}
          </tbody></table>
        </div>
      </div>
      <div className="section"><h3>Begründung</h3><ul className="reasons">{o.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul></div>
      <div className="row section">
        {o.buy.offerUrl && <a className="btn" href={o.buy.offerUrl} target="_blank" rel="noopener noreferrer">Erfasstes Angebot öffnen ↗</a>}
        <a className="btn" href={o.productUrl} target="_blank" rel="noopener noreferrer">Produktseite auf Cardmarket ↗</a>
        <span className="spacer" />
        {o.signalClass === 'LIVE_OFFER' && <button className="btn good" onClick={() => setMode(m => (m === 'buy' ? 'none' : 'buy'))}>Gekauft erfassen</button>}
        <button className="btn danger" onClick={() => setMode(m => (m === 'reject' ? 'none' : 'reject'))}>Ablehnen</button>
      </div>
      {mode === 'buy' && (
        <div className="card section">
          <div className="row">
            <label className="field">Anzahl<NumInput value={qty} onChange={setQty} width={70} /></label>
            <label className="field">Tatsächlicher Preis je Stück (€)<NumInput value={buyPrice} onChange={setBuyPrice} /></label>
            <label className="field">Porto gesamt (€)<NumInput value={shipping} onChange={setShipping} /></label>
            <label className="field">Status<select value={poStatus} onChange={e => setPoStatus(e.target.value as 'ordered')}><option value="planned">Geplant (Kapital reservieren)</option><option value="ordered">Bestellt</option><option value="paid">Bestellt und bezahlt</option></select></label>
            <button className="btn good" style={{ alignSelf: 'flex-end' }} disabled={!confirmed} onClick={() => submit('accepted')}>Einkauf anlegen</button>
          </div>
          <label className="check" style={{ marginTop: 8 }}>
            <input type="checkbox" checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />
            Ich habe das Angebot unmittelbar vor der Zahlung auf der Angebotsseite geprüft (Preis, Zustand, Sprache, noch verfügbar). Eine alte Beobachtung belegt das nicht.
          </label>
          <div className="small muted" style={{ marginTop: 6 }}>Legt einen Einkauf im Purchase Manager an. Die Empfehlung (Score, erwarteter Gewinn) wird mitprotokolliert, damit später Prognose und Ergebnis verglichen werden können.</div>
        </div>
      )}
      {mode === 'reject' && (
        <div className="card section row">
          <input type="text" placeholder="Grund (optional), z. B. Angebot weg, Zustand fraglich" style={{ flex: 1 }} value={reason} onChange={e => setReason(e.target.value)} />
          <button className="btn danger" onClick={() => submit('rejected')}>Ablehnung protokollieren</button>
        </div>
      )}
    </div>
  );
}

export function ProductDrawer({ productId, opportunityKey, onClose }: { productId: number; opportunityKey?: string; onClose: () => void }) {
  const toast = useToast();
  const { data, error, reload } = useAsync(() => api.get<ProductDetail>(`/api/products/${productId}`), [productId]);
  const [finish, setFinish] = useState<'nonfoil' | 'foil'>('nonfoil');
  const [selKey, setSelKey] = useState<string | undefined>(opportunityKey);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  useEffect(() => {
    if (!data) return;
    const o = data.opportunities.find(x => x.key === opportunityKey);
    if (o) setFinish(o.finish);
    else if (!data.finishes.nonfoil && data.finishes.foil) setFinish('foil');
  }, [data, opportunityKey]);
  const fd = data?.finishes[finish];
  const selected = useMemo(() => data?.opportunities.find(o => o.key === selKey) ?? null, [data, selKey]);

  const addWatch = async () => {
    try { await api.post('/api/watchlist', { productId, finish }); toast('Zur Watchlist hinzugefügt.'); reload(); }
    catch (e) { toast((e as Error).message, true); }
  };

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Detailansicht">
        <button className="btn close" onClick={onClose} aria-label="Schließen">✕</button>
        <ErrorNotice error={error} />
        {!data ? <div className="empty">Lade …</div> : (
          <>
            <div className="product-head">
              {data.product.imageUrl && <img src={data.product.imageUrl} alt="" loading="lazy" />}
              <div>
                <h1 style={{ fontSize: 22 }}>{data.product.name}</h1>
                <div className="muted">{data.product.setName ?? 'Edition unbekannt'}{data.product.setCode ? ` (${data.product.setCode}${data.product.collectorNumber ? ' #' + data.product.collectorNumber : ''})` : ''}{data.product.rarity ? ' · ' + data.product.rarity : ''}</div>
                <dl className="kv" style={{ marginTop: 10 }}>
                  <dt>Cardmarket-ID</dt><dd>{data.product.externalId}</dd>
                  <dt>Zuordnung</dt><dd>{{ mapped: 'Druck über Scryfall zugeordnet', ambiguous: 'mehrdeutig (Scryfall)', expansion_only: 'nur Edition bekannt', unmapped: 'nicht zugeordnet' }[data.product.mappingStatus] ?? data.product.mappingStatus}</dd>
                  <dt>Watchlist</dt><dd>{data.watch.length ? data.watch.map(w => `${w.qty}× ${w.targetPrice ? 'Ziel ' + euro(w.targetPrice) : 'ohne Ziel'}`).join(', ') : <button className="btn small" onClick={addWatch}>☆ Beobachten</button>}</dd>
                </dl>
                <div className="row" style={{ marginTop: 10 }}><a className="btn small" href={data.productUrl} target="_blank" rel="noopener noreferrer">Auf Cardmarket öffnen ↗</a></div>
              </div>
            </div>

            <div className="tabs">
              {(['nonfoil', 'foil'] as const).map(f => (
                <button key={f} className={finish === f ? 'active' : ''} disabled={!data.finishes[f]} onClick={() => setFinish(f)}>{f === 'nonfoil' ? 'Nonfoil' : 'Foil'}{!data.finishes[f] ? ' (keine Daten)' : ''}</button>
              ))}
            </div>
            {fd ? (
              <div className="grid cols-2">
                <div className="card">
                  <div className="card-head"><h3>Cardmarket Price Guide</h3><span className="small muted">Stand {dateTime(fd.guide.sourceCreatedAt)}</span></div>
                  <dl className="kv">
                    <dt>Trend</dt><dd>{euro(fd.guide.trend)}</dd>
                    <dt>1-Tages-Ø</dt><dd>{euro(fd.guide.avg1)} {fd.guideMetrics.avg1VsAvg30Pct != null && <span className="muted small">({pct(fd.guideMetrics.avg1VsAvg30Pct, true)} ggü. 30-T)</span>}</dd>
                    <dt>7-Tages-Ø</dt><dd>{euro(fd.guide.avg7)}</dd>
                    <dt>30-Tages-Ø</dt><dd>{euro(fd.guide.avg30)}</dd>
                    <dt>Tiefstpreis</dt><dd>{euro(fd.guide.low)} <span className="muted small">(gemeldet, Zustand/Sprache unbekannt)</span></dd>
                    <dt>Ø Verkaufspreis</dt><dd>{euro(fd.guide.avg)}</dd>
                    <dt>Streuung</dt><dd>{pct(fd.guideMetrics.dispersionCvPct)}{fd.guideMetrics.refRatio != null && fd.guideMetrics.refRatio > 3 && <span className="neg small"> · Ausreißerverdacht</span>}</dd>
                  </dl>
                  <div className="small muted" style={{ marginTop: 8 }}>Aggregierte Tageswerte – keine Einzelangebote, nicht nach Zustand oder Sprache getrennt.</div>
                </div>
                <div className="card">
                  <div className="card-head"><h3>Eigene Historie</h3><span className="small muted">{fd.historyMetrics.days} Tag(e)</span></div>
                  <dl className="kv">
                    {([['1 Tag', fd.historyMetrics.change1d], ['7 Tage', fd.historyMetrics.change7d], ['30 Tage', fd.historyMetrics.change30d]] as const).map(([l, m]) => (
                      <Fragment key={l}><dt>Veränderung {l}</dt><dd>{m.value != null ? pct(m.value, true) : <span className="muted small">{m.note ?? 'unzureichend'}</span>}</dd></Fragment>
                    ))}
                    <dt>Ø 7 / 30 Tage</dt><dd>{euro(fd.historyMetrics.ma7.value)} / {euro(fd.historyMetrics.ma30.value)}</dd>
                    <dt>Volatilität (Tag)</dt><dd>{fd.historyMetrics.vol30.value != null ? pct(fd.historyMetrics.vol30.value) : <span className="muted small">{fd.historyMetrics.vol30.note}</span>}</dd>
                    <dt>Spanne 30 Tage</dt><dd>{fd.historyMetrics.range30 ? `${euro(fd.historyMetrics.range30.min)} – ${euro(fd.historyMetrics.range30.max)} (Rückgang vom Hoch ${pct(fd.historyMetrics.range30.drawdownPct)})` : <span className="muted small">zu wenig Daten</span>}</dd>
                    <dt>Preisumkehr</dt><dd>{fd.historyMetrics.reversal ? 'möglich' : '–'}</dd>
                  </dl>
                </div>
                <div className="card" style={{ gridColumn: '1 / -1' }}>
                  <div className="card-head"><h3>Preisverlauf (eigene Snapshots)</h3></div>
                  <PriceChart data={fd.history} />
                </div>
              </div>
            ) : <div className="empty">Keine Preisdaten für diese Variante.</div>}

            {data.opportunities.length > 0 && (
              <div className="section">
                <h3>Möglichkeiten in der aktuellen Rangliste</h3>
                <div className="tabs">
                  {data.opportunities.map(o => (
                    <button key={o.key} className={selKey === o.key ? 'active' : ''} onClick={() => setSelKey(o.key)}>
                      {STRATEGY_LABEL[o.strategy]}{o.finish === 'foil' ? ' Foil' : ''}{o.buy.seller ? ' · ' + o.buy.seller : ''} · {euro(o.buy.effective)}
                    </button>
                  ))}
                </div>
                {selected ? <OpportunityView key={selected.key} o={selected} onDecided={reload} /> : <div className="small muted">Eine Möglichkeit auswählen, um Kalkulation und Begründung zu sehen.</div>}
              </div>
            )}

            <div className="section">
              <h3>Beobachtete Einzelangebote</h3>
              {data.offers.length === 0 ? <div className="small muted">Keine. Angebote kommen über die Browser-Erweiterung (beim manuellen Besuch der Kartenseite) oder den manuellen Import.</div> : (
                <div className="table-wrap"><table className="compact">
                  <thead><tr><th>Signal</th><th className="num">Preis</th><th>Zustand</th><th>Sprache</th><th>Finish</th><th>Verkäufer</th><th>Beobachtet</th><th></th></tr></thead>
                  <tbody>{data.offers.map(of => (
                    <tr key={of.id}><td><SignalBadge c={of.signalClass} /></td><td className="num">{euro(of.price)}{of.previousPrice != null && <span className="muted small"> (vorher {euro(of.previousPrice)})</span>}</td>
                      <td>{of.condition ?? '?'}</td><td>{of.language ?? '?'}</td><td>{of.finish}</td><td>{of.seller ?? '–'}{of.sellerCountry ? ` (${of.sellerCountry})` : ''}</td>
                      <td>{age(of.observedAt)}</td><td>{of.url && <a href={of.url} target="_blank" rel="noopener noreferrer">öffnen ↗</a>}</td></tr>
                  ))}</tbody>
                </table></div>
              )}
            </div>
          </>
        )}
      </aside>
    </>
  );
}
