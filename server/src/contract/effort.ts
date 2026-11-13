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

/** The effort a launch ran with and why. Both are left out when the agent runs at its runtime's default. */
export interface EffortFields {
  effort?: Effort;
  effortNote?: string;
}

/** The effort fields of `source`, or nothing when it has no effort, so an agent without effort builds the same object as before. */
export function effortFields(source: EffortFields): EffortFields {
  return source.effort
    ? { effort: source.effort, ...(source.effortNote ? { effortNote: source.effortNote } : {}) }
    : {};
}
