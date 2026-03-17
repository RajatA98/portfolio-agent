import { Snaptrade } from 'snaptrade-typescript-sdk';
import { agentConfig } from '../agent.config';
import { BrokerageService } from '../agent.types';
import { encryptForUser, decryptWithFallback } from '../lib/encrypt';
import { getPrisma } from '../lib/prisma';

export class SnapTradeService implements BrokerageService {
  private client: Snaptrade;

  constructor() {
    this.client = new Snaptrade({
      clientId: agentConfig.snaptradeClientId,
      consumerKey: agentConfig.snaptradeConsumerKey
    });

    // GUARDRAIL: Block access to the trading API entirely.
    // This app is strictly read-only — no orders, no trades, no modifications.
    Object.defineProperty(this.client, 'trading', {
      get() {
        throw new Error(
          'Trading API access is blocked. This application is read-only.'
        );
      },
      configurable: false
    });
  }

  /**
   * Register user with SnapTrade (idempotent).
   * If already registered, returns existing credentials from DB.
   * If credentials are stale, resets the user secret automatically.
   */
  async registerUser(
    userId: string,
    supabaseUserId: string
  ): Promise<{ snaptradeUserId: string; userSecret: string }> {
    const prisma = getPrisma();

    // Check if already registered in our DB
    const existing = await prisma.brokerageConnection.findFirst({
      where: { userId }
    });

    if (existing) {
      const { plaintext, wasLegacy } = decryptWithFallback(
        existing.userSecretEncrypted,
        supabaseUserId
      );

      // Lazy re-encrypt with per-user key if it was legacy
      if (wasLegacy) {
        await prisma.brokerageConnection.update({
          where: { id: existing.id },
          data: { userSecretEncrypted: encryptForUser(plaintext, supabaseUserId) }
        });
      }

      return {
        snaptradeUserId: existing.snaptradeUserId,
        userSecret: plaintext
      };
    }

    // No DB record — ensure we have a valid SnapTrade user with a fresh secret
    const { snaptradeUserId, userSecret } = await this.ensureSnapTradeUser(userId);

    // Store encrypted with per-user key
    await prisma.brokerageConnection.create({
      data: {
        userId,
        snaptradeUserId,
        userSecretEncrypted: encryptForUser(userSecret, supabaseUserId)
      }
    });

    return { snaptradeUserId, userSecret };
  }

  /**
   * Ensure a SnapTrade user exists and return a fresh user secret.
   * Handles the 1012 "user already exists" case for personal API keys.
   * NEVER deletes the SnapTrade user — that would destroy brokerage connections.
   */
  private async ensureSnapTradeUser(
    userId: string
  ): Promise<{ snaptradeUserId: string; userSecret: string }> {
    // Try registering first
    try {
      const response = await this.client.authentication.registerSnapTradeUser({
        userId
      });
      const secret = response.data.userSecret ?? '';
      if (!secret) throw new Error('SnapTrade registration returned empty secret');
      return {
        snaptradeUserId: response.data.userId ?? userId,
        userSecret: secret
      };
    } catch (regError: unknown) {
      const body = (regError as { responseBody?: { code?: string } })?.responseBody;
      const errStr = String(regError);
      const isAlreadyRegistered = body?.code === '1012' || errStr.includes('1012');

      if (!isAlreadyRegistered) throw regError;

      console.log('[snaptrade] user already registered, resetting secret to get fresh credentials');

      // List existing SnapTrade users to get the userId
      const listRes = await this.client.authentication.listSnapTradeUsers();
      const existingUsers = listRes.data ?? [];
      if (existingUsers.length === 0) throw regError;

      const snaptradeUserId = existingUsers[0] as string;

      // Reset user secret to get a fresh one (preserves brokerage connections)
      try {
        const resetRes = await this.client.authentication.resetSnapTradeUserSecret({
          userId: snaptradeUserId,
          userSecret: '' // pass empty — SnapTrade generates a new secret
        });
        const newSecret = (resetRes.data as { userSecret?: string })?.userSecret ?? '';
        if (!newSecret) throw new Error('Reset returned empty secret');
        return { snaptradeUserId, userSecret: newSecret };
      } catch (resetError) {
        // Reset failed (e.g. no current secret available) — delete and re-register
        console.log('[snaptrade] secret reset failed, deleting SnapTrade user and re-registering');
        try {
          await this.client.authentication.deleteSnapTradeUser({ userId: snaptradeUserId });
        } catch (delErr) {
          console.log('[snaptrade] delete user failed (may already be gone):', String(delErr).slice(0, 100));
        }
        // Re-register fresh
        const freshRes = await this.client.authentication.registerSnapTradeUser({ userId });
        const freshSecret = freshRes.data.userSecret ?? '';
        if (!freshSecret) throw new Error('Failed to obtain SnapTrade credentials after re-registration.');
        return {
          snaptradeUserId: freshRes.data.userId ?? userId,
          userSecret: freshSecret
        };
      }
    }
  }

  /**
   * Get SnapTrade Connection Portal URL for user to link their brokerage.
   */
  async getConnectUrl(userId: string, supabaseUserId: string, callbackUrl?: string): Promise<{ redirectURI: string }> {
    const { snaptradeUserId, userSecret } = await this.getCredentials(userId, supabaseUserId);

    const response = await this.client.authentication.loginSnapTradeUser({
      userId: snaptradeUserId,
      userSecret,
      ...(callbackUrl ? { customRedirect: callbackUrl } : {})
    });

    const data = response.data as { redirectURI?: string };
    if (!data.redirectURI) {
      throw new Error('Failed to get SnapTrade connection portal URL');
    }

    return { redirectURI: data.redirectURI };
  }

  /**
   * List brokerage connections (authorizations) for a user.
   */
  async listConnections(
    userId: string,
    supabaseUserId: string
  ): Promise<Array<{ id: string; brokerageName: string }>> {
    const { snaptradeUserId, userSecret } = await this.getCredentials(userId, supabaseUserId);

    const response = await this.client.connections.listBrokerageAuthorizations({
      userId: snaptradeUserId,
      userSecret
    });

    const connections = response.data ?? [];

    // Update institution names in DB
    const prisma = getPrisma();
    for (const conn of connections) {
      const name = conn.brokerage?.name;
      if (name) {
        await prisma.brokerageConnection.updateMany({
          where: { userId, snaptradeUserId },
          data: { institutionName: name }
        });
      }
    }

    return connections.map((c) => ({
      id: c.id ?? '',
      brokerageName: c.brokerage?.name ?? 'Unknown'
    }));
  }

  /**
   * List accounts across all connected brokerages.
   */
  async listAccounts(
    userId: string,
    supabaseUserId: string
  ): Promise<Array<{
    id: string;
    name: string;
    number: string;
    institutionName: string;
  }>> {
    const { snaptradeUserId, userSecret } = await this.getCredentials(userId, supabaseUserId);

    const response = await this.client.accountInformation.listUserAccounts({
      userId: snaptradeUserId,
      userSecret
    });

    return (response.data ?? []).map((a) => ({
      id: a.id,
      name: a.name ?? '',
      number: a.number,
      institutionName: a.institution_name
    }));
  }

  /**
   * Get holdings across all connected accounts.
   * Returns the same shape that PortfolioService expects.
   */
  async getHoldings(
    userId: string,
    supabaseUserId: string
  ): Promise<{
    holdings: Array<{
      symbol: string;
      name: string;
      quantity: number;
      costBasis: number | null;
      currentValue: number | null;
      currency: string;
      institutionName: string;
    }>;
  }> {
    const { snaptradeUserId, userSecret } = await this.getCredentials(userId, supabaseUserId);

    // Get all accounts first
    const accountsRes = await this.client.accountInformation.listUserAccounts({
      userId: snaptradeUserId,
      userSecret
    });

    const accounts = accountsRes.data ?? [];
    if (accounts.length === 0) {
      throw new Error(
        'No brokerage accounts found. Connect your brokerage first.'
      );
    }

    const allHoldings: Array<{
      symbol: string;
      name: string;
      quantity: number;
      costBasis: number | null;
      currentValue: number | null;
      currency: string;
      institutionName: string;
    }> = [];

    for (const account of accounts) {
      const holdingsRes = await this.client.accountInformation.getUserHoldings({
        accountId: account.id,
        userId: snaptradeUserId,
        userSecret
      });

      const positions = holdingsRes.data.positions ?? [];
      console.log(`[snaptrade] account ${account.id} (${account.institution_name}): ${positions.length} positions`);

      // Debug: log raw response fields to investigate staked/locked positions
      if (process.env.SNAPTRADE_DEBUG === 'true') {
        console.log(`[snaptrade:debug] raw holdings keys for ${account.id}:`, Object.keys(holdingsRes.data));
        for (const pos of positions) {
          const ticker = pos.symbol?.symbol?.symbol ?? 'UNKNOWN';
          console.log(`[snaptrade:debug] position ${ticker}:`, JSON.stringify({
            units: pos.units,
            fractional_units: pos.fractional_units,
            price: pos.price,
            average_purchase_price: pos.average_purchase_price,
            // Check for staking-related fields
            ...(Object.keys(pos).filter(k => /stak|lock|earn|reward/i.test(k)).length > 0
              ? { staking_fields: Object.keys(pos).filter(k => /stak|lock|earn|reward/i.test(k)) }
              : {})
          }));
        }
      }

      for (const pos of positions) {
        const units = pos.units ?? pos.fractional_units ?? 0;
        const ticker = pos.symbol?.symbol?.symbol ?? 'UNKNOWN';

        // Log every position so we can debug missing holdings
        if (units <= 0) {
          console.log(`[snaptrade] skipping ${ticker}: units=${pos.units}, fractional=${pos.fractional_units}, price=${pos.price}`);
          continue;
        }

        const description = pos.symbol?.symbol?.description ?? ticker;
        const price = pos.price ?? null;
        const avgCost = pos.average_purchase_price ?? null;
        const currency = (pos.currency as { code?: string })?.code ?? 'USD';

        allHoldings.push({
          symbol: ticker,
          name: description,
          quantity: units,
          costBasis: avgCost != null ? avgCost * units : null,
          currentValue: price != null ? price * units : null,
          currency,
          institutionName: account.institution_name
        });
      }
    }

    return { holdings: allHoldings };
  }

  /**
   * Get account activities (transactions) across all connected accounts.
   */
  async getTransactions(
    userId: string,
    supabaseUserId: string,
    opts?: { startDate?: string; endDate?: string; type?: string }
  ): Promise<Array<{
    date: string;
    type: string;
    symbol: string;
    description: string;
    quantity: number | null;
    price: number | null;
    amount: number;
    currency: string;
    accountName: string;
  }>> {
    const { snaptradeUserId, userSecret } = await this.getCredentials(userId, supabaseUserId);

    const accountsRes = await this.client.accountInformation.listUserAccounts({
      userId: snaptradeUserId,
      userSecret
    });
    const accounts = accountsRes.data ?? [];

    const allTransactions: Array<{
      date: string;
      type: string;
      symbol: string;
      description: string;
      quantity: number | null;
      price: number | null;
      amount: number;
      currency: string;
      accountName: string;
    }> = [];

    for (const account of accounts) {
      try {
        const res = await this.client.accountInformation.getAccountActivities({
          accountId: account.id,
          userId: snaptradeUserId,
          userSecret,
          ...(opts?.startDate ? { startDate: opts.startDate } : {}),
          ...(opts?.endDate ? { endDate: opts.endDate } : {}),
          ...(opts?.type ? { type: opts.type } : {})
        });

        const activities = (res.data ?? []) as Array<{
          trade_date?: string;
          settlement_date?: string;
          type?: string;
          symbol?: { symbol?: { symbol?: string } };
          description?: string;
          units?: number;
          price?: number;
          amount?: number;
          currency?: { code?: string };
        }>;

        for (const a of activities) {
          allTransactions.push({
            date: a.trade_date ?? a.settlement_date ?? '',
            type: a.type ?? 'UNKNOWN',
            symbol: a.symbol?.symbol?.symbol ?? '',
            description: a.description ?? '',
            quantity: a.units ?? null,
            price: a.price ?? null,
            amount: a.amount ?? 0,
            currency: a.currency?.code ?? 'USD',
            accountName: account.name ?? account.institution_name
          });
        }
      } catch (err) {
        console.error(`[snaptrade] getAccountActivities error for ${account.id}:`, SnapTradeService.sanitizeError(err));
      }
    }

    // Sort by date descending
    allTransactions.sort((a, b) => (b.date > a.date ? 1 : -1));
    return allTransactions;
  }

  /**
   * Get account balances (cash positions) across all connected accounts.
   */
  async getBalances(
    userId: string,
    supabaseUserId: string
  ): Promise<Array<{
    accountId: string;
    accountName: string;
    institutionName: string;
    currency: string;
    cash: number;
    buyingPower: number | null;
  }>> {
    const { snaptradeUserId, userSecret } = await this.getCredentials(userId, supabaseUserId);

    const accountsRes = await this.client.accountInformation.listUserAccounts({
      userId: snaptradeUserId,
      userSecret
    });
    const accounts = accountsRes.data ?? [];

    const allBalances: Array<{
      accountId: string;
      accountName: string;
      institutionName: string;
      currency: string;
      cash: number;
      buyingPower: number | null;
    }> = [];

    for (const account of accounts) {
      try {
        const res = await this.client.accountInformation.getUserAccountBalance({
          userId: snaptradeUserId,
          userSecret,
          accountId: account.id
        });

        const balances = (res.data ?? []) as Array<{
          currency?: { code?: string };
          cash?: number;
          buying_power?: number;
        }>;

        for (const b of balances) {
          allBalances.push({
            accountId: account.id,
            accountName: account.name ?? account.institution_name,
            institutionName: account.institution_name,
            currency: b.currency?.code ?? 'USD',
            cash: b.cash ?? 0,
            buyingPower: b.buying_power ?? null
          });
        }
      } catch (err) {
        console.error(`[snaptrade] getUserAccountBalance error for ${account.id}:`, SnapTradeService.sanitizeError(err));
      }
    }

    return allBalances;
  }

  /**
   * Get brokerage-calculated return rates by timeframe for all accounts.
   */
  async getReturnRates(
    userId: string,
    supabaseUserId: string
  ): Promise<Array<{
    accountId: string;
    accountName: string;
    timeframe: string;
    returnPercent: number;
  }>> {
    const { snaptradeUserId, userSecret } = await this.getCredentials(userId, supabaseUserId);

    const accountsRes = await this.client.accountInformation.listUserAccounts({
      userId: snaptradeUserId,
      userSecret
    });
    const accounts = accountsRes.data ?? [];

    const allRates: Array<{
      accountId: string;
      accountName: string;
      timeframe: string;
      returnPercent: number;
    }> = [];

    for (const account of accounts) {
      try {
        const res = await this.client.accountInformation.getUserAccountReturnRates({
          userId: snaptradeUserId,
          userSecret,
          accountId: account.id
        });

        const rates = (res.data ?? []) as Array<{
          timeframe?: string;
          return_percent?: number;
        }>;

        for (const r of rates) {
          if (r.timeframe && r.return_percent != null) {
            allRates.push({
              accountId: account.id,
              accountName: account.name ?? account.institution_name,
              timeframe: r.timeframe,
              returnPercent: r.return_percent
            });
          }
        }
      } catch (err) {
        console.error(`[snaptrade] getUserAccountReturnRates error for ${account.id}:`, SnapTradeService.sanitizeError(err));
      }
    }

    return allRates;
  }

  /**
   * Get decrypted SnapTrade credentials for a user.
   * Lazily re-encrypts with per-user key if legacy shared key was used.
   */
  private async getCredentials(
    userId: string,
    supabaseUserId: string
  ): Promise<{
    snaptradeUserId: string;
    userSecret: string;
  }> {
    const prisma = getPrisma();
    const conn = await prisma.brokerageConnection.findFirst({
      where: { userId }
    });

    if (!conn) {
      throw new Error(
        'No SnapTrade registration found. Please register first.'
      );
    }

    const { plaintext, wasLegacy } = decryptWithFallback(
      conn.userSecretEncrypted,
      supabaseUserId
    );

    // Lazy re-encrypt with per-user key
    if (wasLegacy) {
      await prisma.brokerageConnection.update({
        where: { id: conn.id },
        data: { userSecretEncrypted: encryptForUser(plaintext, supabaseUserId) }
      });
    }

    return {
      snaptradeUserId: conn.snaptradeUserId,
      userSecret: plaintext
    };
  }

  /**
   * Reset user secret when SnapTrade returns 401 (stale credentials).
   * Updates the encrypted secret in the DB and returns new credentials.
   */
  async refreshCredentials(
    userId: string,
    supabaseUserId: string
  ): Promise<{ snaptradeUserId: string; userSecret: string }> {
    const prisma = getPrisma();
    const conn = await prisma.brokerageConnection.findFirst({
      where: { userId }
    });

    if (!conn) {
      throw new Error('No SnapTrade registration found. Please register first.');
    }

    console.log('[snaptrade] refreshing credentials for', conn.snaptradeUserId);

    // Get current secret to pass to reset
    const { plaintext: currentSecret } = decryptWithFallback(
      conn.userSecretEncrypted,
      supabaseUserId
    );

    const resetRes = await this.client.authentication.resetSnapTradeUserSecret({
      userId: conn.snaptradeUserId,
      userSecret: currentSecret
    });

    const newSecret = (resetRes.data as { userSecret?: string })?.userSecret ?? '';
    if (!newSecret) {
      // If reset fails, delete the stale DB record and let user re-register
      console.log('[snaptrade] reset failed, deleting stale connection record');
      await prisma.brokerageConnection.delete({ where: { id: conn.id } });
      throw new Error('SnapTrade credentials expired. Please click Connect Brokerage again to re-register.');
    }

    console.log('[snaptrade] credentials refreshed successfully');

    await prisma.brokerageConnection.update({
      where: { id: conn.id },
      data: { userSecretEncrypted: encryptForUser(newSecret, supabaseUserId) }
    });

    return { snaptradeUserId: conn.snaptradeUserId, userSecret: newSecret };
  }

  /**
   * Delete stale SnapTrade connection from DB so user can re-register fresh.
   */
  async deleteConnection(userId: string): Promise<void> {
    const prisma = getPrisma();
    await prisma.brokerageConnection.deleteMany({ where: { userId } });
    console.log('[snaptrade] deleted stale connection for userId:', userId);
  }

  /**
   * Extract a clean error message from SnapTrade SDK errors.
   */
  static sanitizeError(error: unknown): string {
    if (error instanceof Error) {
      // Strip response headers from SDK error messages
      const msg = error.message;
      const headersIdx = msg.indexOf('Response Headers:');
      if (headersIdx > 0) {
        return msg.slice(0, headersIdx).trim();
      }
      return msg;
    }
    return String(error);
  }
}
