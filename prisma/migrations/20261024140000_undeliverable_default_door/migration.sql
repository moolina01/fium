-- Por defecto, si el cliente no está, el conductor deja el pedido en la puerta.
ALTER TABLE "StoreConfig" ALTER COLUMN "undeliverableAction" SET DEFAULT 'leave_at_door';
-- La columna se creó hoy con 'return' para todas: se pasan al nuevo valor por defecto.
UPDATE "StoreConfig" SET "undeliverableAction" = 'leave_at_door';
