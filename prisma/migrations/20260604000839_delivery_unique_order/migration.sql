-- Deduplicar deliveries existentes: conservar el más reciente por (shop, orderId)
DELETE FROM "Delivery"
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY shop, "orderId"
             ORDER BY "createdAt" DESC, id DESC
           ) AS rn
    FROM "Delivery"
  ) ranked
  WHERE ranked.rn > 1
);

-- CreateIndex
CREATE UNIQUE INDEX "Delivery_shop_orderId_key" ON "Delivery"("shop", "orderId");
