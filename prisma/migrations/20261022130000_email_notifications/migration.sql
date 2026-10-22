-- AlterTable
ALTER TABLE "StoreConfig" ADD COLUMN     "notifyEmail" TEXT,
ADD COLUMN     "notifyCanceled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "notifyNewOrder" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notifyReminder" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "OrderManifest" ADD COLUMN     "orderNumber" TEXT,
ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "customerComuna" TEXT,
ADD COLUMN     "reminderSentAt" TIMESTAMP(3);
