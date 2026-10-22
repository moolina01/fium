-- AlterTable
ALTER TABLE "OrderManifest" ADD COLUMN     "customerAddress" TEXT,
ADD COLUMN     "customerPhone" TEXT,
ADD COLUMN     "orderTotal" DOUBLE PRECISION,
ADD COLUMN     "orderNote" TEXT;
