import { git, gitMissing } from '../git';

/** Exit codes of `merge-base`: 1 when there is no common ancestor, 128 when a commit is not known to this repository. */
const NO_ANSWER = [1, 128];

async function mergeBase(cwd: string, candidate: string): Promise<string | null> {
  try {
    return (await git(['-C', cwd, 'merge-base', 'HEAD', candidate], undefined, { answers: NO_ANSWER })) || null;
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error ? (error as { code?: unknown }).code : null;
    if (typeof code === 'number' && NO_ANSWER.includes(code)) return null;
    throw error;
  }
}

async function isAncestor(cwd: string, older: string, newer: string): Promise<boolean> {
  try {
    await git(['-C', cwd, 'merge-base', '--is-ancestor', older, newer], undefined, { answers: [1] });
    return true;
  } catch (error) {
    if (gitMissing(error)) return false;
    throw error;
  }
}

/**
 * The commit a run's own change is measured from: a move carries `ownBase..HEAD` onto the new base, as
 * `git rebase --onto <new> <ownBase>` does. `known` holds the commits the run is known to have stood on (the tip it
 * was made from, the tips its moves landed on, the heads its parent had before they moved), and `base` is the commit it
 * moves onto. The result is the newest merge base of HEAD with any of them. For a branch cut from a base that was never
 * rewritten that is the merge base git finds anyway; after the base was rewritten it is the old tip the run stood on,
 * never the older commit the two histories share.
 */
export async function ownChangeBase(cwd: string, known: string[], base: string): Promise<string> {
  let newest: string | null = null;
  for (const candidate of [...known, base]) {
    const found = await mergeBase(cwd, candidate);
    if (found && (newest === null || (found !== newest && (await isAncestor(cwd, newest, found))))) {
      newest = found;
    }
  }
  return newest ?? base;
}

/** True when the head of the checkout changes anything relative to `ownBase`. */
export async function hasOwnChange(cwd: string, ownBase: string): Promise<boolean> {
  const [head, tip] = await Promise.all([
    git(['-C', cwd, 'rev-parse', 'HEAD^{tree}']),
    git(['-C', cwd, 'rev-parse', `${ownBase}^{tree}`]),
  ]);
  return head !== tip;
}
