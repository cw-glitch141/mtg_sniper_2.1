import type { Opportunity } from '../../server/src/analytics/opportunity.ts';
import type { AppSettings } from '../../server/src/domain/settings.ts';
import type { ObservedOffer, SnapshotPoint, GuidePrices, ProductInfo } from '../../server/src/domain/types.ts';
import type { GuideMetrics, HistoryMetrics } from '../../server/src/analytics/stats.ts';
import type { TradeResult, ScenarioResults } from '../../server/src/analytics/profit.ts';
import type { ResaleEstimate } from '../../server/src/analytics/resale.ts';

export type { Opportunity, AppSettings, ObservedOffer, SnapshotPoint, GuidePrices, ProductInfo, GuideMetrics, HistoryMetrics, TradeResult, ScenarioResults, ResaleEstimate };

export class ApiError extends Error {
  status: number;
  details: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* kein JSON */ }
  if (!res.ok) {
    const j = json as { error?: string; details?: unknown } | null;
    const details = Array.isArray(j?.details) ? ': ' + (j?.details as string[]).join('; ') : '';
    throw new ApiError(res.status, (j?.error ?? `HTTP ${res.status}`) + details, j?.details);
  }
  return json as T;
}

export const api = {
  get: <T>(p: string) => request<T>('GET', p),
  post: <T>(p: string, b: unknown = {}) => request<T>('POST', p, b),
  put: <T>(p: string, b: unknown) => request<T>('PUT', p, b),
  patch: <T>(p: string, b: unknown) => request<T>('PATCH', p, b),
  del: <T>(p: string) => request<T>('DELETE', p),
};

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    u.set(k, v === true ? '1' : String(v));
  }
  const s = u.toString();
  return s ? '?' + s : '';
}

// --- Antworttypen der API ---
export interface SourceStatus {
  source: string; label: string; lastSuccessAt: string | null; dataCreatedAt: string | null; ageHours: number | null;
  stale: boolean; failing: boolean; lastRun: { status: string; startedAt: string; finishedAt: string | null; message: string | null } | null;
}
export interface Status {
  app: string; version: string; now: string; sources: SourceStatus[]; warnings: string[];
  counts: { products: number; mapped: number; priceSeries: number; historyDays: number; snapshots: number; liveOffers: number; simulatedOffers: number; watchOpen: number; unreadAlerts: number };
  analysis: { id: number; started_at: string; finished_at: string | null; status: string; candidates: number; opportunities: number; data_date: string | null; message: string | null } | null;
  importRunning: boolean;
  scheduler: { running: boolean; lastTickAt: string | null; lastError: string | null } | null;
  channels: { telegram: boolean; discord: boolean; email: boolean };
  liveOfferProviders: string[];
}
export interface OppList { runId: number | null; total: number; items: Opportunity[] }
export interface Mover { productId: number; name: string; setName: string | null; imageUrl: string | null; finish: string; fromPrice: number; toPrice: number; changePct: number; fromDate: string | null; toDate: string; basis: string }
export interface Movers { basis: string; note: string; items: Mover[] }
export interface AlertItem {
  id: number; kind: string; signalClass: 'MARKET_SIGNAL' | 'LIVE_OFFER' | 'SIMULATION'; signalLabel: string; priority: Priority | null; priorityLabel: string | null; title: string; message: string;
  payload: { name?: string; setName?: string | null; condition?: string | null; buyPrice?: number | null; sellEstimate?: number | null; profit?: number | null; roiPct?: number | null; confidence?: number | null; dataDate?: string | null; observedAt?: string | null; source?: string | null; url?: string | null; productUrl?: string | null; opportunityKey?: string };
  createdAt: string; readAt: string | null; deliveries: Record<string, string>;
}
export interface WatchEntry { id: number; listName: string; nameKey: string; name: string; productId: number | null; finish: string | null; qty: number; targetPrice: number | null; bought: boolean; url: string | null; notes: string | null; origin: string; addedAt: string; minCondition: string | null; languages: string[] | null }
export interface SearchHit { id: number; externalId: number; name: string; setName: string | null; setCode: string | null; collectorNumber: string | null; rarity: string | null; imageUrl: string | null; trend: number | null; avg30: number | null; trendFoil: number | null }
export interface FinishData { guide: GuidePrices; guideMetrics: GuideMetrics; history: SnapshotPoint[]; historyMetrics: HistoryMetrics }
export interface ProductDetail { product: ProductInfo; finishes: Partial<Record<'nonfoil' | 'foil', FinishData>>; productUrl: string; offers: ObservedOffer[]; opportunities: Opportunity[]; watch: WatchEntry[] }
export interface Realized { costBasis: number; revenue: number; vat: number; fees: number; profit: number | null; days: number | null; missingFees: boolean }
export interface InventoryItem {
  id: number; productId: number | null; name: string; setName: string | null; condition: string | null; language: string | null; finish: string; qty: number;
  buyPrice: number; buyShipping: number; buyOtherCosts: number; buyDate: string; seller: string | null; buySource: string | null;
  status: 'ordered' | 'delivered' | 'listed' | 'sold' | 'returned'; listPrice: number | null; listedAt: string | null; sellPrice: number | null; sellDate: string | null;
  platformFees: number | null; sellShippingCost: number | null; sellOtherCosts: number | null; decisionId: number | null; notes: string | null; marketTrend: number | null; realized: Realized;
}
export interface Kpis {
  taxMode: string; soldLots: number; soldUnits: number; revenue: number; realizedProfit: number; avgProfitPerCard: number | null; capitalRoiPct: number | null;
  avgDaysToSell: number | null; inventoryTurnover: number | null; lossShareTradesPct: number | null; missingFeeEntries: number; openLots: number; openUnits: number;
  capitalBound: number; marketValueOpen: number | null; byStatus: Record<string, number>; monthly: { month: string; revenue: number; profit: number; units: number }[];
  recommendations: { accepted: number; rejected: number; evaluated: number; successRatePct: number | null; meanPredictionErrorEur: number | null };
}
export interface Decision {
  id: number; createdAt: string; opportunityKey: string; productId: number | null; signalClass: string; strategy: string; decision: 'accepted' | 'rejected'; reason: string | null;
  score: number; confidence: number; buyPrice: number; expectedSellBase: number | null; expectedProfitBase: number | null; purchaseLineId: number | null; purchaseOrderId: number | null; priority: string | null;
  name: string | null; setName: string | null; finish: string | null; currentTrend: number | null; currentDataDate: string | null; trendVsBuyPct: number | null;
}
// --- 2.1 Business Edition ---
export type Priority = 'HIGH' | 'MEDIUM' | 'WATCH';
export interface Lot {
  id: number; code: string; productId: number | null; externalId: number | null; name: string; setName: string | null; setCode: string | null; collectorNumber: string | null;
  finish: string; condition: string | null; language: string | null; ownership: 'business' | 'private'; privateDeck: string | null;
  qtyReceived: number; qtyOnHand: number; qtyReserved: number; qtySold: number; qtyAvailable: number; unitCost: number; unitAlloc: number; unitFullCost: number;
  vatTreatment: string; acquiredAt: string; receivedAt: string; ageDays: number; slow: boolean; locationId: number | null; location: string | null; warehouse: string | null;
  listPrice: number | null; listPlatform: string | null; listedAt: string | null; minPriceOverride: number | null; salesStatus: string; deliveryStatus: string | null;
  purchaseOrderId: number | null; supplier: string | null; marketTrend: number | null; realizedRevenue: number; notes: string | null;
}
export interface LotList { total: number; items: Lot[] }
export interface Movement { id: number; type: string; qty: number; refType: string | null; refId: number | null; note: string | null; actor: string; createdAt: string }
export interface Location { id: number; warehouse: string; code: string; description: string | null; active: number; lots: number; units: number }
export interface PurchaseSummary {
  id: number; supplier: string | null; platform: string; externalRef: string | null; status: string; vatTreatment: string; shippingCost: number; otherCosts: number;
  refundAmount: number; orderedAt: string | null; paidAt: string | null; receivedAt: string | null; problemNote: string | null; notes: string | null; createdAt: string;
  lineCount: number; units: number; receivedUnits: number; goodsValue: number; total: number;
}
export interface PurchaseDetail extends PurchaseSummary {
  lines: { id: number; productId: number | null; name: string; setName: string | null; finish: string; condition: string | null; language: string | null; qty: number; unitPrice: number;
    receivedQty: number; decisionId: number | null; allocatedCosts: number; unitLandedCost: number; lots: { id: number; code: string; qty: number }[] }[];
}
export interface OrderResultApi { units: number; revenueGross: number; outputVat: number; netRevenue: number; cogs: number; inputVat: number; fees: number; shipping: number; packaging: number; other: number; refund: number; contribution: number; vatLiability: number; laborMinutes: number; laborCost: number; profitAfterLabor: number }
export interface SalesOrder {
  id: number; platform: string; externalOrderId: string | null; buyer: string | null; buyerCountry: string | null; shipAddress: string | null; status: string; paymentStatus: string;
  priority: number; overdue: boolean; shippingCharged: number; shippingCost: number | null; packagingCost: number | null; platformFee: number | null; paymentFee: number | null;
  otherCosts: number | null; refundAmount: number; carrier: string | null; trackingNumber: string | null; orderedAt: string; paidAt: string | null; shippedAt: string | null;
  completedAt: string | null; problemNote: string | null; notes: string | null; archived: boolean; units: number; itemsValue: number; missing: number; result: OrderResultApi | null;
  lines: { id: number; productId: number | null; name: string; setName: string | null; finish: string; condition: string | null; language: string | null; qty: number; unitPrice: number;
    missingQty: number; returnedQty: number; allocations: { id: number; lotId: number; lotCode: string; qty: number; status: string; returnedQty: number; location: string | null; warehouse: string | null }[] }[];
}
export interface OrderList { total: number; items: SalesOrder[] }
export interface Picklist {
  createdAt: string; orders: number; warnings: string[];
  items: { lotId: number; lotCode: string; location: string | null; warehouse: string | null; name: string; setName: string | null; finish: string; condition: string | null; language: string | null; qty: number; orders: { orderId: number; ref: string; qty: number; lineId: number }[] }[];
}
export interface Reprice {
  lotId: number; lotCode: string; productId: number | null; name: string; setName: string | null; finish: string; condition: string | null; language: string | null; location: string | null;
  qtyAvailable: number; unitFullCost: number; listPrice: number | null; listedAt: string | null; daysListed: number | null; ageDays: number; marketBase: number | null;
  marketConservative: number | null; marketDataDate: string | null; marketVsCostPct: number | null; breakEven: number; floor: number; target: number;
  action: string; actionLabel: string; suggested: number | null; notes: string[];
}
export interface PortfolioOverview {
  capitalTracked: boolean; cash: number; totalTradingCapital: number; availableCapital: number; reservedForPurchases: number; inTransit: number; investedInStock: number;
  unsold: { units: number; cost: number }; reserved: { units: number; salesValue: number }; receivables: number;
  expectedProceeds: { value: number; coveredUnits: number; unvaluedUnits: number; isForecast: true; note: string };
  realizedRevenue: number; realizedContribution: number; openObligations: number; vatLiabilityEstimate: number; liquidityReserve: number; slowMoverSharePct: number;
  ledger: { deposits: number; withdrawals: number; expenses: number; taxPayments: number; adjustments: number; entries: number }; warnings: string[];
}
export interface Portfolio {
  overview: PortfolioOverview; limits: AppSettings['limits'] & { maxCapitalPerCard: number; maxInventoryCapital: number };
  concentration: { bySet: { setName: string | null; units: number; cost: number; overLimit: boolean }[]; byCard: { productId: number | null; name: string; finish: string; units: number; cost: number; overLimit: boolean }[] };
}
export interface LedgerEntry { id: number; type: string; amount: number; bookedAt: string; category: string | null; note: string | null; createdAt: string }
export interface PortfolioPoint { date: string; units: number; costValue: number; marketValue: number | null; marketCovered: number }
export interface MonthRow {
  month: string; orders: number; units: number; returnedUnits: number; revenueGross: number; netRevenue: number; cogs: number; contribution: number; expenses: number;
  profitBeforeTax: number; vatLiability: number; laborHours: number; laborCost: number; profitAfterLabor: number; profitPerHour: number | null; cashIn: number; cashOut: number;
  netCashFlow: number; purchases: number;
}
export interface ProfitAnalytics {
  basis: string;
  kpis: { monthRevenue: number; monthContribution: number; salesUnitsTotal: number; ordersTotal: number; avgProfitPerCard: number | null; avgProfitPerOrder: number | null;
    profitPerLaborHour: number | null; avgStorageDays: number | null; inventoryTurnover: number | null; capitalBound: number; currentStockUnits: number; openOrders: number;
    returnRatePct: number | null; recommendationSuccessPct: number | null; recommendationSample: number };
  totals: { revenueGross: number; netRevenue: number; contribution: number; expenses: number; profitBeforeTax: number; vatLiability: number; laborHours: number; cashIn: number; cashOut: number };
  forecast: { isForecast: true; expectedProceeds: PortfolioOverview['expectedProceeds']; unsold: { units: number; cost: number }; note: string };
  monthly: MonthRow[];
}
export interface ValidationGroup { group: string; decisions: number; unitsBought: number; unitsSold: number; sellThroughPct: number | null; avgDaysToSell: number | null; contribution: number; contributionPerUnit: number | null; lossDecisions: number; profitableDecisions: number; boundCapital: number; insufficient: boolean }
export interface Validation {
  minSample: number; note: string;
  overall: { recommendationsLogged: number; accepted: number; rejected: number; boughtSharePct: number | null; decisionsWithSales: number; unitsBought: number; unitsSold: number; successRatePct: number | null; meanPredictionErrorPerUnit: number | null; boundCapital: number };
  byStrategy: ValidationGroup[]; bySignalClass: ValidationGroup[]; byPriority: ValidationGroup[]; byPriceBand: ValidationGroup[]; byRarity: ValidationGroup[]; byFinish: ValidationGroup[];
  byScoreBand: ValidationGroup[]; byConfidenceBand: ValidationGroup[];
  lossMakers: { decisionId: number; name: string; setName: string | null; strategy: string; contribution: number; unitsSold: number }[];
  filterTests: { filter: string; threshold: number; decisions: number; contributionPerUnit: number | null; lossSharePct: number | null; insufficient: boolean }[];
}

export interface CalcResult {
  buyShipping: number; shippingNote: string; resale: ResaleEstimate | null; scenarios: ScenarioResults | null; manual: TradeResult | null;
  breakEvenSellPrice: number | null; maxBuyPrice: number | null; maxBuyPriceBasis: string | null; taxMode: string;
}
