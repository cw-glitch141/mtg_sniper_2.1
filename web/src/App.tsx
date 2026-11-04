import { createContext, Fragment, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, type AlertItem, type Status } from './api';
import { ProductDrawer } from './components/ProductDrawer';
import { Overview } from './pages/Overview';
import { Scanner } from './pages/Scanner';
import { Offers } from './pages/Offers';
import { Watchlist } from './pages/Watchlist';
import { Alerts } from './pages/Alerts';
import { Calculator } from './pages/Calculator';
import { Settings } from './pages/Settings';
import { DataSources } from './pages/DataSources';
import { MarketWatch } from './pages/MarketWatch';
import { LiveRadar } from './pages/LiveRadar';
import { Purchases } from './pages/Purchases';
import { Inventory } from './pages/Inventory';
import { Orders } from './pages/Orders';
import { Shipping } from './pages/Shipping';
import { Analytics } from './pages/Analytics';
import { Capital } from './pages/Capital';

const PAGES = [
  { id: 'overview', label: 'Übersicht', el: Overview, group: 'Markt' },
  { id: 'scanner', label: 'Kaufchancen (Angebote)', el: Scanner },
  { id: 'live', label: 'Live-Radar', el: LiveRadar },
  { id: 'market', label: 'Market Watch / Recherche', el: MarketWatch },
  { id: 'offers', label: 'Angebote & Bündel', el: Offers },
  { id: 'watchlist', label: 'Watchlist', el: Watchlist },
  { id: 'alerts', label: 'Alarme', el: Alerts },
  { id: 'purchases', label: 'Purchase Manager', el: Purchases, group: 'Geschäft' },
  { id: 'inventory', label: 'Inventory', el: Inventory },
  { id: 'orders', label: 'Sales Orders', el: Orders },
  { id: 'shipping', label: 'Shipping Center', el: Shipping },
  { id: 'analytics', label: 'Profit Analytics', el: Analytics, group: 'Auswertung' },
  { id: 'capital', label: 'Capital & Risk', el: Capital },
  { id: 'calc', label: 'Profit-Rechner', el: Calculator, group: 'System' },
  { id: 'data', label: 'Datenquellen', el: DataSources },
  { id: 'settings', label: 'Settings', el: Settings },
] as const;

type PageId = typeof PAGES[number]['id'];

interface Shell {
  openProduct: (productId: number, opportunityKey?: string) => void;
  navigate: (page: PageId, params?: Record<string, string>) => void;
  status: Status | null;
  refreshStatus: () => void;
  params: URLSearchParams;
}
const ShellCtx = createContext<Shell>(null as unknown as Shell);
export const useShell = () => useContext(ShellCtx);

function parseHash(): { page: PageId; params: URLSearchParams } {
  const [p, q] = location.hash.replace(/^#\/?/, '').split('?');
  const page = (PAGES.find(x => x.id === p)?.id ?? 'overview') as PageId;
  return { page, params: new URLSearchParams(q ?? '') };
}

export function App() {
  const [route, setRoute] = useState(parseHash);
  const [drawer, setDrawer] = useState<{ productId: number; key?: string } | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const lastAlertId = useRef<number | null>(null);

  useEffect(() => {
    const on = () => setRoute(parseHash());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  // Direktlink auf die Detailansicht: #/scanner?product=123&key=price_dip:123:foil
  useEffect(() => {
    const id = Number(route.params.get('product'));
    if (Number.isInteger(id) && id > 0) setDrawer({ productId: id, key: route.params.get('key') ?? undefined });
  }, [route]);

  const refreshStatus = useCallback(() => { api.get<Status>('/api/status').then(setStatus).catch(() => setStatus(null)); }, []);

  // Status + neue Alarme regelmäßig abfragen; Desktop-Benachrichtigung, wenn erlaubt.
  useEffect(() => {
    refreshStatus();
    const poll = async () => {
      refreshStatus();
      try {
        const list = await api.get<AlertItem[]>(`/api/alerts?limit=20${lastAlertId.current != null ? '&sinceId=' + lastAlertId.current : ''}`);
        if (lastAlertId.current != null && list.length && 'Notification' in window && Notification.permission === 'granted') {
          const s = await api.get<{ settings: { alerts: { channels: { desktop: boolean } } } }>('/api/settings');
          if (s.settings.alerts.channels.desktop) {
            for (const a of list.slice(0, 3).reverse()) new Notification(`[${a.signalLabel}] ${a.title}`, { body: a.message.slice(0, 180), tag: `mtgds-${a.id}` });
          }
        }
        if (list.length) lastAlertId.current = Math.max(lastAlertId.current ?? 0, ...list.map(a => a.id));
        else if (lastAlertId.current == null) lastAlertId.current = 0;
      } catch { /* Server nicht erreichbar – Statusleiste zeigt das */ }
    };
    void poll();
    const t = setInterval(poll, 60_000);
    return () => clearInterval(t);
  }, [refreshStatus]);

  const shell: Shell = {
    openProduct: (productId, opportunityKey) => setDrawer({ productId, key: opportunityKey }),
    navigate: (page, params) => { location.hash = `#/${page}${params ? '?' + new URLSearchParams(params).toString() : ''}`; },
    status, refreshStatus, params: route.params,
  };
  const Page = PAGES.find(p => p.id === route.page)?.el ?? Overview;
  const guide = status?.sources.find(s => s.source === 'cardmarket_price_guide');

  return (
    <ShellCtx.Provider value={shell}>
      <div className="app">
        <nav className="sidebar" aria-label="Hauptnavigation">
          <div className="brand">MTG Deal Sniper 2.2<small>Business Edition</small></div>
          <div className="nav">
            {PAGES.map(p => (
              <Fragment key={p.id}>
                {'group' in p && <div className="group">{p.group}</div>}
                <a href={`#/${p.id}`} className={route.page === p.id ? 'active' : ''}>
                  {p.label}
                  {p.id === 'alerts' && !!status?.counts.unreadAlerts && <span className="count">{status.counts.unreadAlerts}</span>}
                </a>
              </Fragment>
            ))}
          </div>
          <div className="foot">
            {status ? (
              <>
                <div><span className={`dot ${guide?.failing ? 'fail' : guide?.stale ? 'stale' : 'ok'}`} style={{ display: 'inline-block', marginRight: 6 }} />Price Guide {guide?.dataCreatedAt ? new Date(guide.dataCreatedAt).toLocaleDateString('de-DE') : 'fehlt'}</div>
                <div>Historie: {status.counts.historyDays} Tag(e)</div>
                <div title={status.live?.headline}><span className={`dot ${status.live?.available ? 'ok' : 'fail'}`} style={{ display: 'inline-block', marginRight: 6 }} />Live-Feed: {status.live?.available ? 'verbunden' : 'keiner'}</div>
                <div>v{status.version}</div>
              </>
            ) : <div className="neg">Server nicht erreichbar</div>}
          </div>
        </nav>
        <main className="main">
          {status === null && <div className="notice error">Der lokale Server antwortet nicht. Läuft <code>npm start</code>?</div>}
          <Page />
        </main>
      </div>
      {drawer && <ProductDrawer productId={drawer.productId} opportunityKey={drawer.key} onClose={() => setDrawer(null)} />}
    </ShellCtx.Provider>
  );
}
