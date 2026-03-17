/**
 * Mock BrokerageService for evals.
 * Returns static, realistic fake portfolio data so evals can run
 * without a live server, auth, or real brokerage connections.
 */

import { BrokerageHolding, BrokerageService } from '../agent.types';

const MOCK_HOLDINGS: BrokerageHolding[] = [
  {
    symbol: 'AAPL',
    name: 'Apple Inc.',
    quantity: 10,
    costBasis: 1500,       // $150/share
    currentValue: 1950,    // $195/share
    currency: 'USD',
    institutionName: 'Mock Brokerage'
  },
  {
    symbol: 'VTI',
    name: 'Vanguard Total Stock Market ETF',
    quantity: 25,
    costBasis: 5000,       // $200/share
    currentValue: 5500,    // $220/share
    currency: 'USD',
    institutionName: 'Mock Brokerage'
  },
  {
    symbol: 'MSFT',
    name: 'Microsoft Corporation',
    quantity: 8,
    costBasis: 2400,       // $300/share
    currentValue: 3360,    // $420/share
    currency: 'USD',
    institutionName: 'Mock Brokerage'
  },
  {
    symbol: 'BTC',
    name: 'Bitcoin',
    quantity: 0.5,
    costBasis: 15000,      // $30000/unit
    currentValue: 33500,   // $67000/unit
    currency: 'USD',
    institutionName: 'Mock Brokerage'
  },
  {
    symbol: 'BND',
    name: 'Vanguard Total Bond Market ETF',
    quantity: 30,
    costBasis: 2160,       // $72/share
    currentValue: 2100,    // $70/share
    currency: 'USD',
    institutionName: 'Mock Brokerage'
  }
];

const MOCK_TRANSACTIONS = [
  { date: '2026-03-10', type: 'BUY', symbol: 'AAPL', description: 'Buy Apple Inc.', quantity: 5, price: 195, amount: -975, currency: 'USD', accountName: 'Mock Brokerage' },
  { date: '2026-03-05', type: 'DIVIDEND', symbol: 'VTI', description: 'Dividend payment', quantity: null, price: null, amount: 32.50, currency: 'USD', accountName: 'Mock Brokerage' },
  { date: '2026-02-28', type: 'BUY', symbol: 'MSFT', description: 'Buy Microsoft Corporation', quantity: 3, price: 415, amount: -1245, currency: 'USD', accountName: 'Mock Brokerage' },
  { date: '2026-02-15', type: 'SELL', symbol: 'BND', description: 'Sell Vanguard Total Bond Market ETF', quantity: 10, price: 71, amount: 710, currency: 'USD', accountName: 'Mock Brokerage' },
  { date: '2026-02-01', type: 'DIVIDEND', symbol: 'AAPL', description: 'Dividend payment', quantity: null, price: null, amount: 9.60, currency: 'USD', accountName: 'Mock Brokerage' },
  { date: '2026-01-20', type: 'BUY', symbol: 'BTC', description: 'Buy Bitcoin', quantity: 0.1, price: 64000, amount: -6400, currency: 'USD', accountName: 'Mock Brokerage' },
  { date: '2026-01-10', type: 'BUY', symbol: 'VTI', description: 'Buy Vanguard Total Stock Market ETF', quantity: 10, price: 215, amount: -2150, currency: 'USD', accountName: 'Mock Brokerage' },
  { date: '2025-12-15', type: 'FEE', symbol: '', description: 'Account maintenance fee', quantity: null, price: null, amount: -4.99, currency: 'USD', accountName: 'Mock Brokerage' }
];

const MOCK_BALANCES = [
  {
    accountId: 'mock-acct-001',
    accountName: 'Individual Brokerage',
    institutionName: 'Mock Brokerage',
    currency: 'USD',
    cash: 2534.17,
    buyingPower: 2534.17
  }
];

const MOCK_RETURN_RATES = [
  { accountId: 'mock-acct-001', accountName: 'Individual Brokerage', timeframe: '1M', returnPercent: 1.2 },
  { accountId: 'mock-acct-001', accountName: 'Individual Brokerage', timeframe: '3M', returnPercent: 4.5 },
  { accountId: 'mock-acct-001', accountName: 'Individual Brokerage', timeframe: '6M', returnPercent: 8.1 },
  { accountId: 'mock-acct-001', accountName: 'Individual Brokerage', timeframe: '1Y', returnPercent: 12.3 },
  { accountId: 'mock-acct-001', accountName: 'Individual Brokerage', timeframe: 'ALL', returnPercent: 18.7 }
];

export class MockBrokerageService implements BrokerageService {
  async getHoldings(
    _userId: string,
    _supabaseUserId: string
  ): Promise<{ holdings: BrokerageHolding[] }> {
    return { holdings: [...MOCK_HOLDINGS] };
  }

  async getTransactions(
    _userId: string,
    _supabaseUserId: string,
    opts?: { startDate?: string; endDate?: string; type?: string }
  ) {
    let txns = [...MOCK_TRANSACTIONS];

    if (opts?.startDate) {
      txns = txns.filter((t) => t.date >= opts.startDate!);
    }
    if (opts?.endDate) {
      txns = txns.filter((t) => t.date <= opts.endDate!);
    }
    if (opts?.type) {
      const types = opts.type.split(',').map((t) => t.trim().toUpperCase());
      txns = txns.filter((t) => types.includes(t.type));
    }

    return txns;
  }

  async getBalances(_userId: string, _supabaseUserId: string) {
    return [...MOCK_BALANCES];
  }

  async getReturnRates(_userId: string, _supabaseUserId: string) {
    return [...MOCK_RETURN_RATES];
  }
}
