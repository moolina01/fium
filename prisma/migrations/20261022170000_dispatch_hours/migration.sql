-- AlterTable
ALTER TABLE "StoreConfig" ADD COLUMN     "dispatchDays" TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
ADD COLUMN     "dispatchStart" TEXT NOT NULL DEFAULT '09:00',
ADD COLUMN     "dispatchCutoff" TEXT NOT NULL DEFAULT '19:00';
