import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

export const SIGNAL_LABEL = { MARKET_SIGNAL: 'MARKTSIGNAL', LIVE_OFFER: 'LIVE-ANGEBOT', SIMULATION: 'SIMULATION', SYSTEM: 'SYSTEM' } as const;
const SIGNAL_TITLE = {
  MARKET_SIGNAL: 'Aus aggregierten/historischen Cardmarket-Preisdaten. Kein kaufbares Angebot.',
  LIVE_OFFER: 'Tatsächlich beobachtetes Einzelangebot (Zeitpunkt der Beobachtung beachten).',
  SIMULATION: 'Testdaten – keine Kaufmöglichkeit.',
  SYSTEM: 'Betreiber-Meldung (Datenausfall, Feed-Fehler) – kein Handelssignal.',
} as const;

export function SignalBadge({ c }: { c: keyof typeof SIGNAL_LABEL }) {
  return <span className={`badge ${c}`} title={SIGNAL_TITLE[c]}>{c === 'LIVE_OFFER' ? '●' : c === 'SIMULATION' ? '◇' : c === 'SYSTEM' ? '⚙' : '◆'} {SIGNAL_LABEL[c]}</span>;
}

/** Zusatzkennzeichen neben der Signalklasse: VERALTET und TEST. */
export function ExtraLabels({ labels }: { labels?: string[] }) {
  if (!labels) return null;
  return <>{labels.filter(l => l === 'VERALTET' || l === 'TEST').map(l => (
    <span key={l} className={`badge ${l === 'VERALTET' ? 'STALE' : 'SIMULATION'}`} title={l === 'VERALTET' ? 'Daten älter als die Frische-Grenze – vor einer Entscheidung neu prüfen.' : 'Erfundene Testdaten aus dem TEST-Feed.'}>{l === 'VERALTET' ? '⏱' : '◇'} {l}</span>
  ))}</>;
}

const PRIO_LABEL = { HIGH: 'HIGH PRIORITY', MEDIUM: 'MEDIUM', WATCH: 'MARKET WATCH' } as const;
const PRIO_TITLE = {
  HIGH: 'Aktuelles Live-Angebot, hohe konservative Rentabilität, gute Datenqualität, alle Kauflimits eingehalten.',
  MEDIUM: 'Interessant, aber Rentabilität oder Datenlage noch prüfen.',
  WATCH: 'Preisentwicklung oder Auffälligkeit – nicht zwingend ein kaufbares Angebot.',
} as const;
export function PriorityBadge({ p }: { p: 'HIGH' | 'MEDIUM' | 'WATCH' | null | undefined }) {
  if (!p) return null;
  return <span className={`badge prio-${p}`} title={PRIO_TITLE[p]}>{p === 'HIGH' ? '▲' : p === 'MEDIUM' ? '■' : '○'} {PRIO_LABEL[p]}</span>;
}

export const ORDER_STATUS_LABEL: Record<string, string> = {
  new: 'Neu', checked: 'Geprüft', picking: 'Pickliste', packed: 'Gepackt', shipped: 'Versendet', completed: 'Abgeschlossen',
  cancelled: 'Storniert', returned: 'Retourniert', problem: 'Problem',
};
export const PO_STATUS_LABEL: Record<string, string> = {
  planned: 'Geplant (reserviert)', ordered: 'Bestellt', paid: 'Bezahlt', partially_received: 'Teilgeliefert', received: 'Eingelagert',
  cancelled: 'Storniert', problem: 'Problem', returned: 'Zurückgegeben', manuell: 'manuell erfasst',
};
export const ALLOC_STATUS_LABEL: Record<string, string> = { reserved: 'reserviert', shipped: 'versendet', returned: 'zurück', released: 'freigegeben' };
export function StatusPill({ s, map }: { s: string; map: Record<string, string> }) {
  return <span className={`pill st-${s}`}>{map[s] ?? s}</span>;
}

export function Rec({ r }: { r: string }) {
  const icon = r === 'KAUFEN' ? '✓' : r === 'PRÜFEN' ? '?' : '–';
  return <span className={`rec ${r.split(' ')[0]}`}>{icon} {r}</span>;
}

export function Score({ v, title }: { v: number; title?: string }) {
  return (
    <span className="score tabnum" title={title}>
      <span className="bar"><i style={{ width: `${Math.max(0, Math.min(100, v))}%` }} /></span>
      {Math.round(v)}
    </span>
  );
}

export function Money({ v, signed }: { v: number | null | undefined; signed?: boolean }) {
  if (v == null) return <span className="muted">–</span>;
  const s = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(v);
  return <span className={signed ? (v > 0 ? 'pos' : v < 0 ? 'neg' : '') : ''}>{signed && v > 0 ? '+' : ''}{s}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

// ---------------------------------------------------------------- Toasts
type Toast = { id: number; text: string; error?: boolean };
const ToastCtx = createContext<(text: string, error?: boolean) => void>(() => {});
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts(t => [...t, { id, text, error }]);
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), error ? 8000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div style={{ position: 'fixed', right: 20, bottom: 20, display: 'grid', gap: 8, zIndex: 60 }}>
        {toasts.map(t => <div key={t.id} className={`toast${t.error ? ' error' : ''}`} style={{ position: 'static' }} role="status">{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ---------------------------------------------------------------- Daten laden
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    const my = ++seq.current;
    setLoading(true);
    fn().then(d => { if (my === seq.current) { setData(d); setError(null); } })
      .catch(e => { if (my === seq.current) setError((e as Error).message); })
      .finally(() => { if (my === seq.current) setLoading(false); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data, error, loading, reload: () => setTick(t => t + 1) };
}

export function ErrorNotice({ error }: { error: string | null }) {
  return error ? <div className="notice error">Fehler: {error}</div> : null;
}

/** Zahlenfeld, das deutsche Eingaben akzeptiert und null für leer liefert. */
export function NumInput({ value, onChange, placeholder, width = 100, step }: { value: number | null | undefined; onChange: (v: number | null) => void; placeholder?: string; width?: number; step?: string }) {
  const [text, setText] = useState(value == null ? '' : String(value).replace('.', ','));
  useEffect(() => { setText(value == null ? '' : String(value).replace('.', ',')); }, [value]);
  return (
    <input type="text" inputMode="decimal" style={{ width }} value={text} placeholder={placeholder} data-step={step}
      onChange={e => setText(e.target.value)}
      onBlur={() => {
        const t = text.trim();
        if (!t) { onChange(null); return; }
        const n = Number(t.replace(/\s|€/g, '').replace(',', '.'));
        if (Number.isFinite(n)) onChange(n); else setText(value == null ? '' : String(value).replace('.', ','));
      }} />
  );
}
