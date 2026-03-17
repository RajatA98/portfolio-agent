import Big from 'big.js';

import {
  AccountBalancesResult,
  AllocationRow,
  HoldingRow,
  Money,
  PerformanceResult,
  PortfolioSnapshotResult,
  ReturnRatesResult,
  TransactionHistoryResult,
  ValuationMethod
} from '../agent.types';
import { fetchYahooQuote, toYahooSymbol } from '../lib/yahoo';
import { BrokerageService } from '../agent.types';

interface CachedSnapshot {
  data: PortfolioSnapshotResult;
  ts: number;
}

export class PortfolioService {
  private cache = new Map<string, CachedSnapshot>();
  private static readonly CACHE_TTL_MS = 60_000; // 60s

  constructor(private readonly brokerageService: BrokerageService) {}

  async getSnapshot(
    userId: string,
    baseCurrency: string,
    supabaseUserId?: string
  ): Promise<PortfolioSnapshotResult> {
    const cached = this.cache.get(userId);
    if (cached && Date.now() - cached.ts < PortfolioService.CACHE_TTL_MS) {
      return cached.data;
    }

    const { holdings: brokerageHoldings } =
      await this.brokerageService.getHoldings(userId, supabaseUserId ?? userId);

    let isPriceDataMissing = false;
    const holdings: HoldingRow[] = [];

    for (const h of brokerageHoldings) {
      const yahooSymbol = toYahooSymbol(h.symbol);
      const quote = fetchYahooQuote(yahooSymbol);

      let price: Money | null = null;
      let value: Money | null = null;

      if (quote) {
        price = { currency: quote.currency, amount: quote.price };
        // Use Big to avoid floating-point artifacts (e.g., 421.55000000000007)
        // that break verifier numeric matching
        value = { currency: quote.currency, amount: new Big(quote.price).times(h.quantity).toNumber() };
      } else if (h.currentValue != null && h.quantity > 0) {
        // Fall back to brokerage institution-provided value
        const unitPrice = h.currentValue / h.quantity;
        price = { currency: h.currency, amount: unitPrice };
        value = { currency: h.currency, amount: h.currentValue };
      } else if (h.costBasis != null && h.quantity > 0) {
        // Last resort: cost basis
        isPriceDataMissing = true;
        const unitPrice = h.costBasis / h.quantity;
        price = { currency: h.currency, amount: unitPrice };
        value = { currency: h.currency, amount: h.costBasis };
      } else {
        isPriceDataMissing = true;
      }

      holdings.push({
        symbol: h.symbol,
        name: h.name,
        quantity: h.quantity,
        costBasis: h.costBasis != null
          ? { currency: h.currency, amount: h.costBasis }
          : null,
        price,
        value,
        assetClass: this.classifyAsset(h.symbol)
      });
    }

    const totalValue = holdings.reduce(
      (sum, h) => sum.plus(new Big(h.value?.amount ?? 0)),
      new Big(0)
    );

    const allocationBySymbol: AllocationRow[] = holdings.map((h) => {
      const holdingValue = new Big(h.value?.amount ?? 0);
      const percent = totalValue.gt(0)
        ? holdingValue.div(totalValue).times(100).toNumber()
        : 0;
      return {
        key: h.symbol,
        value: { currency: baseCurrency, amount: holdingValue.toNumber() },
        percent: Math.round(percent * 100) / 100
      };
    });

    const assetClassMap = new Map<string, Big>();
    for (const h of holdings) {
      const cls = h.assetClass ?? 'UNKNOWN';
      const val = new Big(h.value?.amount ?? 0);
      assetClassMap.set(cls, (assetClassMap.get(cls) ?? new Big(0)).plus(val));
    }

    const allocationByAssetClass: AllocationRow[] = Array.from(
      assetClassMap.entries()
    ).map(([key, val]) => ({
      key,
      value: { currency: baseCurrency, amount: val.toNumber() },
      percent: totalValue.gt(0)
        ? Math.round(val.div(totalValue).times(100).toNumber() * 100) / 100
        : 0
    }));

    const valuationMethod: ValuationMethod = isPriceDataMissing
      ? 'cost_basis'
      : 'market';
    const now = new Date().toISOString().split('T')[0];

    // Build price map for verifier computed-value matching
    const priceMap: Record<string, number> = {};
    for (const h of holdings) {
      if (h.price?.amount != null) {
        priceMap[h.symbol] = h.price.amount;
      }
    }

    const result: PortfolioSnapshotResult = {
      accountId: 'snaptrade',
      timeframe: { start: '', end: now },
      valuationMethod,
      asOf: valuationMethod === 'market' ? now : null,
      totalValue: { currency: baseCurrency, amount: totalValue.toNumber() },
      allocationBySymbol,
      allocationByAssetClass,
      holdings,
      isPriceDataMissing,
      priceMap
    };

    this.cache.set(userId, { data: result, ts: Date.now() });
    return result;
  }

  async getPerformance(
    userId: string,
    baseCurrency: string,
    supabaseUserId?: string
  ): Promise<PerformanceResult> {
    const snapshot = await this.getSnapshot(userId, baseCurrency, supabaseUserId);
    const now = new Date().toISOString().split('T')[0];

    let totalCostBasis = new Big(0);
    let totalCurrentValue = new Big(0);

    for (const h of snapshot.holdings) {
      totalCostBasis = totalCostBasis.plus(
        new Big(h.costBasis?.amount ?? h.value?.amount ?? 0)
      );
      totalCurrentValue = totalCurrentValue.plus(
        new Big(h.value?.amount ?? 0)
      );
    }

    const totalReturnPercent = totalCostBasis.gt(0)
      ? totalCurrentValue
          .minus(totalCostBasis)
          .div(totalCostBasis)
          .times(100)
          .toNumber()
      : null;

    return {
      accountId: 'snaptrade',
      timeframe: { start: '', end: now },
      valuationMethod: snapshot.valuationMethod,
      asOf: now,
      totalReturnPercent:
        totalReturnPercent != null
          ? Math.round(totalReturnPercent * 100) / 100
          : null,
      timeSeries: [],
      reasonIfUnavailable:
        'Historical time series is not available from brokerage data. Showing point-in-time gain/loss from cost basis vs current market value.'
    };
  }

  async getTransactionHistory(
    userId: string,
    baseCurrency: string,
    supabaseUserId?: string,
    opts?: { startDate?: string; endDate?: string; type?: string; symbol?: string }
  ): Promise<TransactionHistoryResult> {
    const transactions = await this.brokerageService.getTransactions(
      userId,
      supabaseUserId ?? userId,
      { startDate: opts?.startDate, endDate: opts?.endDate, type: opts?.type }
    );

    // Filter by symbol if requested
    let filtered = transactions;
    if (opts?.symbol) {
      const sym = opts.symbol.toUpperCase();
      filtered = transactions.filter((t) => t.symbol.toUpperCase() === sym);
    }

    return {
      accountId: 'snaptrade',
      transactions: filtered.map((t) => ({
        date: t.date,
        type: t.type,
        symbol: t.symbol,
        description: t.description,
        quantity: t.quantity,
        price: t.price != null ? { currency: t.currency, amount: t.price } : null,
        amount: { currency: t.currency, amount: t.amount },
        currency: t.currency,
        accountName: t.accountName
      })),
      totalCount: filtered.length,
      filters: {
        startDate: opts?.startDate,
        endDate: opts?.endDate,
        type: opts?.type,
        symbol: opts?.symbol
      }
    };
  }

  async getAccountBalances(
    userId: string,
    baseCurrency: string,
    supabaseUserId?: string
  ): Promise<AccountBalancesResult> {
    const balances = await this.brokerageService.getBalances(userId, supabaseUserId ?? userId);

    const totalCash = balances.reduce((sum, b) => sum + b.cash, 0);

    return {
      balances: balances.map((b) => ({
        accountId: b.accountId,
        accountName: b.accountName,
        institutionName: b.institutionName,
        currency: b.currency,
        cash: b.cash,
        buyingPower: b.buyingPower
      })),
      totalCash: { currency: baseCurrency, amount: totalCash },
      asOf: new Date().toISOString().split('T')[0]
    };
  }

  async getReturnRates(
    userId: string,
    baseCurrency: string,
    supabaseUserId?: string
  ): Promise<ReturnRatesResult> {
    const rates = await this.brokerageService.getReturnRates(userId, supabaseUserId ?? userId);

    return {
      rates: rates.map((r) => ({
        accountId: r.accountId,
        accountName: r.accountName,
        timeframe: r.timeframe,
        returnPercent: r.returnPercent
      })),
      asOf: new Date().toISOString().split('T')[0]
    };
  }

  invalidateCache(userId: string): void {
    this.cache.delete(userId);
  }

  private classifyAsset(symbol: string): string {
    const upper = symbol.toUpperCase();
    const cryptoSymbols = new Set([
      'BTC', 'ETH', 'SOL', 'XRP', 'ADA', 'DOGE', 'AVAX', 'DOT',
      'MATIC', 'LINK', 'UNI', 'LTC', 'BCH', 'ATOM', 'XLM', 'VET',
      'FIL', 'TRX', 'ETC', 'XMR', 'NEAR', 'APT', 'ARB', 'OP',
      'INJ', 'SUI', 'SEI', 'TIA', 'PEPE', 'SHIB'
    ]);
    if (cryptoSymbols.has(upper)) return 'CRYPTO';
    return 'EQUITY';
  }
}
