import db from "../db.server";

export const PLAN_LIMITS: Record<string, number> = {
  starter: 15,
  growth: 100,
  pro: Infinity,
  none: 0,
};

export function getPlanLimit(plan: string): number {
  return PLAN_LIMITS[plan] ?? 0;
}

export async function getMonthlyDeliveryCount(shop: string): Promise<number> {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  return db.delivery.count({
    where: {
      shop,
      createdAt: { gte: start },
      // failed nunca llegaron a Uber — no cuentan contra el límite
      status: { not: "failed" },
    },
  });
}

export async function checkPlanLimit(shop: string): Promise<{
  allowed: boolean;
  used: number;
  limit: number;
  plan: string;
}> {
  // TEMP(promt02): clientes de prueba sin cobro → acceso ilimitado, sin gate de plan.
  // El límite Infinity hace que el banner de uso del dashboard se auto-oculte
  // (condicionado a usage.limit !== Infinity en app._index.tsx).
  // Revertir cuando se cobre: borrar este bloque y descomentar el ORIGINAL de abajo.
  const config = await db.storeConfig.findUnique({ where: { shop } });
  const used = await getMonthlyDeliveryCount(shop);
  return { allowed: true, used, limit: Infinity, plan: config?.plan ?? "free" };

  /* ORIGINAL (revertir cuando se cobre):
  const config = await db.storeConfig.findUnique({ where: { shop } });
  const plan = config?.plan ?? "none";

  // Plan cancelado o inactivo = sin acceso
  if (!config || config.planStatus !== "active") {
    return { allowed: false, used: 0, limit: 0, plan: "none" };
  }

  const limit = getPlanLimit(plan);
  if (limit === 0) return { allowed: false, used: 0, limit: 0, plan };

  const used = await getMonthlyDeliveryCount(shop);
  if (limit === Infinity) return { allowed: true, used, limit: Infinity, plan };

  return { allowed: used < limit, used, limit, plan };
  */
}
