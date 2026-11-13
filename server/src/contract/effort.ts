/** How hard an agent works, in the same five words for every runtime. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type Effort = (typeof EFFORTS)[number];

export function isEffort(text: string): text is Effort {
  return (EFFORTS as readonly string[]).includes(text);
}

/** The wanted level when listed, else the highest listed level below it, else null. */
export function highestOf(levels: readonly Effort[], wanted: Effort): Effort | null {
  const limit = EFFORTS.indexOf(wanted);
  const fits = EFFORTS.filter((level, index) => index <= limit && levels.includes(level));
  return fits[fits.length - 1] ?? null;
}
