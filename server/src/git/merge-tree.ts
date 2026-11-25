import { git } from './git';

/** A scratch commit is never referenced: it only needs an identity, whatever the repository is set up with. */
const SCRATCH_IDENTITY = {
  GIT_AUTHOR_NAME: 'swarmloop',
  GIT_AUTHOR_EMAIL: 'swarmloop@localhost',
  GIT_COMMITTER_NAME: 'swarmloop',
  GIT_COMMITTER_EMAIL: 'swarmloop@localhost',
};

/**
 * One scratch commit for the tree of `rev` and one for HEAD, both on `ownBase`: git merges them from `ownBase`, the
 * change a rebase of the own commits onto `ref` would carry, not from the merge base it finds in the real history.
 */
async function measuredFrom(path: string, ownBase: string, ref: string): Promise<[string, string]> {
  const scratch = (rev: string) =>
    git(['-C', path, 'commit-tree', `${rev}^{tree}`, '-p', ownBase, '-m', 'scratch'], SCRATCH_IDENTITY);
  return [await scratch(ref), await scratch('HEAD')];
}

/**
 * The files git cannot merge between a ref and the head of a worktree. Empty when they merge cleanly. With `ownBase`
 * the merge is measured from that commit instead of the merge base git finds.
 */
export async function mergeConflicts(path: string, ref: string, ownBase?: string): Promise<string[]> {
  try {
    const [ours, theirs] = ownBase ? await measuredFrom(path, ownBase, ref) : [ref, 'HEAD'];
    await git(['-C', path, 'merge-tree', '--write-tree', '--name-only', '--no-messages', ours, theirs]);
    return [];
  } catch (error) {
    const out = error instanceof Error && 'stdout' in error ? String(error.stdout) : '';
    return out.split('\n').slice(1).filter(Boolean);
  }
}
