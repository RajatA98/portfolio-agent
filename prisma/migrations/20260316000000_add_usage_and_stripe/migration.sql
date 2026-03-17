-- AlterTable
ALTER TABLE "User" ADD COLUMN "stripeCustomerId" TEXT,
ADD COLUMN "subscriptionStatus" TEXT NOT NULL DEFAULT 'free',
ADD COLUMN "subscriptionId" TEXT;

-- CreateTable
CREATE TABLE "Usage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Usage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Usage_userId_periodStart_key" ON "Usage"("userId", "periodStart");

-- CreateIndex
CREATE INDEX "Usage_userId_idx" ON "Usage"("userId");

-- AddForeignKey
ALTER TABLE "Usage" ADD CONSTRAINT "Usage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
