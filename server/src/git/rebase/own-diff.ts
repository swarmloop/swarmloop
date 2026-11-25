import { gitRaw } from '../git';

/** The identity of a diff that does not move with its line numbers: `git patch-id --stable`. */
async function diffId(cwd: string, range: string[]): Promise<string> {
  const diff = await gitRaw(['-C', cwd, 'diff', ...range]);
  return (await gitRaw(['-C', cwd, 'patch-id', '--stable'], undefined, diff)).split(' ')[0].trim();
}

/**
 * True when the branch changes the same things after a rebase as before it: `before` is the head the branch had,
 * `ownBase` the commit its own change was measured from (the one a move carries `ownBase..before` from), `base` the
 * commit it was rebased onto, and the head of the checkout is the result.
 */
export async function sameOwnDiff(cwd: string, ownBase: string, before: string, base: string): Promise<boolean> {
  const [then, now] = await Promise.all([diffId(cwd, [ownBase, before]), diffId(cwd, [base, 'HEAD'])]);
  return then === now;
}
