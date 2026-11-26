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

/** True when `wanted` is set and `own` is unset or lower. */
export function raisesEffort(wanted: Effort | undefined, own: Effort | undefined): boolean {
  return wanted !== undefined && (own === undefined || EFFORTS.indexOf(wanted) > EFFORTS.indexOf(own));
}

/** Where an entry's level comes from: its own, the entry before it, or the base level of its list. */
export type EffortOrigin = 'own' | 'above' | 'default';

/** One entry of a list at its level. `wanted` is the level before the cap, which the next entry inherits. */
interface ListedEffort {
  effort: Effort | null;
  wanted: Effort;
  from: EffortOrigin;
}

/**
 * The level of every entry of one agent list. An entry runs at its own effort, else the level the entry before it
 * wanted, else `base`; that is then held to the highest level `levelsOf(index)` offers. An entry whose runtime offers
 * no level gets none, and still passes its wanted level on.
 */
export function effortsOfList(
  entries: readonly { own?: Effort }[],
  base: Effort,
  levelsOf: (index: number) => readonly Effort[],
): ListedEffort[] {
  const listed: ListedEffort[] = [];
  entries.forEach(({ own }, index) => {
    const above = listed[index - 1]?.wanted;
    const wanted = own ?? above ?? base;
    const from: EffortOrigin = own ? 'own' : above ? 'above' : 'default';
    listed.push({ effort: highestOf(levelsOf(index), wanted), wanted, from });
  });
  return listed;
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
