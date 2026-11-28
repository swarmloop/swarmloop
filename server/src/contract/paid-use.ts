/**
 * Whether a person's agents may use paid usage past their plan's limit on a runtime. A runtime whose paid use cannot be
 * seen reads on and cannot be turned off; for any other it is the person's own setting, off when nothing is stored.
 */
export function paysPastLimit(readsPaidUse: boolean, stored: boolean | undefined): boolean {
  return !readsPaidUse || stored === true;
}

/** What the Settings page and the Connections page say of a runtime whose paid use swarmloop cannot see. */
export function paidUseUnseenNote(label: string): string {
  return `swarmloop cannot see paid use on ${label}, so set a spend cap at the provider.`;
}
