import { git, gitMissing } from '../git';

/**
 * True when a worktree has not reached its branch step yet: it is detached (`current` is empty) and the run's branch
 * does not exist. Such a run has no change of its own, so a move puts it on the new base like any run without one.
 */
export async function isBeforeBranch(cwd: string, current: string, branch: string): Promise<boolean> {
  if (current !== '') return false;
  try {
    await git(['-C', cwd, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`], undefined, { answers: [1] });
    return false;
  } catch (error) {
    if (gitMissing(error)) return true;
    throw error;
  }
}
