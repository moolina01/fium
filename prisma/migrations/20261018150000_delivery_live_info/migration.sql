-- AlterTable
ALTER TABLE "Delivery" ADD COLUMN "pickupEta" TIMESTAMP(3),
ADD COLUMN "dropoffEta" TIMESTAMP(3),
ADD COLUMN "courierName" TEXT,
ADD COLUMN "courierPhone" TEXT,
ADD COLUMN "courierVehicle" TEXT,
ADD COLUMN "liveSyncedAt" TIMESTAMP(3);
