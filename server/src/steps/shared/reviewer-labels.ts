import { REVIEWS } from '../contract/artifacts';

/** The label of every reviewer a run can have stored, the retired ones included. */
export const LABELS: Record<string, string> = {
  [REVIEWS.of('requirements')]: 'Requirements',
  [REVIEWS.of('code')]: 'Code',
  [REVIEWS.of('behavior')]: 'Behavior',
  [REVIEWS.of('quality')]: 'Quality',
  [REVIEWS.of('regressions')]: 'Regressions',
  [REVIEWS.of('security')]: 'Security',
  [REVIEWS.of('performance')]: 'Performance',
};

/** The reviewer's label for a person, from its name. */
export function reviewerLabel(name: string): string {
  return LABELS[REVIEWS.of(name)] ?? name;
}

/** The reviewer a question of the code review names: `<reviewer> still returns: …`. Null for any other question. */
export function askedReviewer(question: string): string | null {
  return /^(\S+) still returns: /.exec(question)?.[1] ?? null;
}
