import { LEGACY_MACHINE } from '../contract/people';

/** The `madeBy` of an app made on first run, before any person has signed in through it. */
export const FIRST_RUN_MAKER = 'first-run';

/** True for an app whose maker is not a person yet: the first person to sign in through it takes it over. */
export function takesOverApp(madeBy: string | null | undefined): boolean {
  return madeBy === FIRST_RUN_MAKER || madeBy === LEGACY_MACHINE;
}
