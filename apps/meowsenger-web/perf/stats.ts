export const pct = (xs: number[], p: number): number => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
};
export const median = (xs: number[]) => pct(xs, 0.5);
export const r1 = (n: number) => (Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
