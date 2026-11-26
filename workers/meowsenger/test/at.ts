/** Element `i` of `arr`, failing the test loudly instead of yielding `undefined` (noUncheckedIndexedAccess-safe). */
export function at<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected an element at index ${i}`);
  return v;
}
