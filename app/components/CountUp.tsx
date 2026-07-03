import { useEffect, useState } from "react";

// Empieza en 0 (igual en server y client → sin mismatch de hidratación) y sube
// con ease-out hasta `end`. Se usa en cualquier métrica que valga la pena
// sentir "viva" en vez de aparecer de golpe (onboarding, stats del dashboard).
export function CountUp({ end, duration = 1100, delay = 0 }: { end: number; duration?: number; delay?: number }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let raf = 0;
    let start: number | null = null;
    const tick = (t: number) => {
      if (start === null) start = t;
      const p = Math.min((t - start) / duration, 1);
      const eased = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setN(Math.round(eased * end));
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    const timer = setTimeout(() => { raf = requestAnimationFrame(tick); }, delay);
    return () => { clearTimeout(timer); cancelAnimationFrame(raf); };
  }, [end, duration, delay]);
  return <>{n}</>;
}
