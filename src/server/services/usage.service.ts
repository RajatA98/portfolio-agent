import { getPrisma } from '../lib/prisma';

/** Start of current day in UTC (YYYY-MM-DD 00:00:00.000Z). */
function currentPeriodStart(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

export interface UsageSummary {
  periodStart: Date;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export class UsageService {
  /**
   * Increment token usage for the current period. Upserts the Usage row for userId + periodStart.
   */
  async recordUsage(
    userId: string,
    inputTokens: number,
    outputTokens: number
  ): Promise<void> {
    const periodStart = currentPeriodStart();
    const prisma = getPrisma();

    await prisma.usage.upsert({
      where: {
        userId_periodStart: { userId, periodStart }
      },
      create: {
        userId,
        periodStart,
        inputTokens,
        outputTokens
      },
      update: {
        inputTokens: { increment: inputTokens },
        outputTokens: { increment: outputTokens }
      }
    });
  }

  /**
   * Get usage for the current period for a user.
   */
  async getUsageForCurrentPeriod(userId: string): Promise<UsageSummary | null> {
    const periodStart = currentPeriodStart();
    const prisma = getPrisma();

    const row = await prisma.usage.findUnique({
      where: {
        userId_periodStart: { userId, periodStart }
      }
    });

    if (!row) {
      return null;
    }

    return {
      periodStart: row.periodStart,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.inputTokens + row.outputTokens
    };
  }

  /**
   * Get total tokens used in the current period, or 0 if no record.
   */
  async getTotalTokensThisPeriod(userId: string): Promise<number> {
    const summary = await this.getUsageForCurrentPeriod(userId);
    return summary?.totalTokens ?? 0;
  }

  /**
   * Reset token usage for all accounts (all periods). Use for admin/maintenance only.
   */
  async resetAllUsage(): Promise<number> {
    const prisma = getPrisma();
    const result = await prisma.usage.deleteMany({});
    return result.count;
  }
}
