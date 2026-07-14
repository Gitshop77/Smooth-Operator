/** Drop a token count to `undefined` when it is zero/non-positive. */
export const omitZero = (n: number): number | undefined => (n > 0 ? n : undefined);
