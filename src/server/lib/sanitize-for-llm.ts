/**
 * Sanitizes portfolio tool results before sending to the LLM.
 *
 * Goal: Anthropic sees allocation percentages, symbols, and asset classes
 * but NOT dollar amounts, share counts, or account identifiers.
 * Market prices (public data) are kept.
 */

const REDACTED = '[REDACTED]';

/** Strip Money objects down to currency only (no amount). */
function redactMoney(m: unknown): unknown {
  if (m && typeof m === 'object' && 'amount' in m && 'currency' in m) {
    return { currency: (m as { currency: string }).currency, amount: REDACTED };
  }
  return m;
}

function sanitizeSnapshot(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };

  // Redact totalValue
  out.totalValue = redactMoney(out.totalValue);

  // Redact priceMap (per-share prices)
  delete out.priceMap;

  // Sanitize holdings — keep symbol, name, assetClass, percent; strip quantity, price, value, costBasis
  if (Array.isArray(out.holdings)) {
    out.holdings = (out.holdings as Record<string, unknown>[]).map((h) => ({
      symbol: h.symbol,
      name: h.name,
      assetClass: h.assetClass
      // quantity, price, value, costBasis all stripped
    }));
  }

  // Sanitize allocation rows — keep key + percent, redact value
  if (Array.isArray(out.allocationBySymbol)) {
    out.allocationBySymbol = (out.allocationBySymbol as Record<string, unknown>[]).map((row) => ({
      key: row.key,
      percent: row.percent
      // value stripped
    }));
  }

  if (Array.isArray(out.allocationByAssetClass)) {
    out.allocationByAssetClass = (out.allocationByAssetClass as Record<string, unknown>[]).map((row) => ({
      key: row.key,
      percent: row.percent
    }));
  }

  return out;
}

function sanitizeBalances(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };
  out.totalCash = redactMoney(out.totalCash);

  if (Array.isArray(out.balances)) {
    out.balances = (out.balances as Record<string, unknown>[]).map((b) => ({
      accountId: b.accountId,
      currency: b.currency,
      cash: REDACTED,
      buyingPower: REDACTED
      // accountName and institutionName stripped
    }));
  }

  return out;
}

function sanitizeTransactions(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };

  if (Array.isArray(out.transactions)) {
    out.transactions = (out.transactions as Record<string, unknown>[]).map((t) => ({
      date: t.date,
      type: t.type,
      symbol: t.symbol,
      description: t.description,
      currency: t.currency
      // quantity, price, amount all stripped
    }));
  }

  return out;
}

function sanitizeSimulation(data: Record<string, unknown>): Record<string, unknown> {
  const out = { ...data };

  out.originalTotalValue = redactMoney(out.originalTotalValue);
  out.newTotalValue = redactMoney(out.newTotalValue);

  if (Array.isArray(out.newAllocationBySymbol)) {
    out.newAllocationBySymbol = (out.newAllocationBySymbol as Record<string, unknown>[]).map((row) => ({
      key: row.key,
      percent: row.percent
    }));
  }

  // Redact dollar amounts in notes
  if (Array.isArray(out.notes)) {
    out.notes = (out.notes as string[]).map((note) =>
      note.replace(/\b\d[\d,.]*\b/g, REDACTED)
    );
  }

  return out;
}

/**
 * Sanitize a tool result before it is sent to the LLM as a tool_result message.
 * Returns a new object (does not mutate the original).
 *
 * Tools with only percentage data (getPerformance, getReturnRates) pass through
 * unchanged. Market prices (public data) also pass through.
 */
export function sanitizeToolResultForLLM(
  toolName: string,
  result: unknown
): unknown {
  if (result == null || typeof result !== 'object') return result;

  const data = result as Record<string, unknown>;

  switch (toolName) {
    case 'getPortfolioSnapshot':
    case 'getPortfolioData':
      return sanitizeSnapshot(data);

    case 'getAccountBalances':
      return sanitizeBalances(data);

    case 'getTransactionHistory':
      return sanitizeTransactions(data);

    case 'simulateAllocationChange':
      return sanitizeSimulation(data);

    // These only have percentages / public data — pass through
    case 'getPerformance':
    case 'getReturnRates':
    case 'getMarketPrices':
    case 'connectBrokerage':
    default:
      return result;
  }
}
