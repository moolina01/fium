// Tiendas en MODO PRUEBA de Uber: activan el robo-courier (sandbox) para que los
// envíos creados avancen solos hasta "entregado", sin courier real ni costo.
//
// Es SOLO para la revisión de Shopify (la app store review) — así los revisores
// ven el flujo completo. NO afecta a tiendas reales: cualquier dominio que no esté
// en esta lista usa el comportamiento normal de producción.
//
// 👉 Cuando termine la review, quita el dominio de aquí (o deja la lista vacía).
const TEST_SHOPS = new Set<string>([
  "pruebatienda111-uyzii5r3.myshopify.com",
]);

export function isUberTestShop(shop: string): boolean {
  return TEST_SHOPS.has(shop);
}
