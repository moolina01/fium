-- Fium es una app gratuita: se elimina por completo el cobro por suscripción
-- (Billing API de Shopify). Estas columnas solo alimentaban los planes/suscripción.
ALTER TABLE "StoreConfig" DROP COLUMN IF EXISTS "plan";
ALTER TABLE "StoreConfig" DROP COLUMN IF EXISTS "planStatus";
ALTER TABLE "StoreConfig" DROP COLUMN IF EXISTS "subscriptionId";
