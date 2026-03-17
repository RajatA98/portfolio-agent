/**
 * Reset token usage for all accounts. Deletes all rows from the Usage table.
 * Run from repo root: npx tsx scripts/reset-usage.ts
 * Requires DATABASE_URL (and DIRECT_URL if using Prisma with it) in .env.
 */
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const result = await prisma.usage.deleteMany({});
    console.log(`Reset complete: deleted ${result.count} usage record(s) for all accounts.`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Failed to reset usage:', err);
  process.exit(1);
});
