import { SwarmloopError } from '../core/swarmloop-error';
import { git, gitDetail } from '../git/git';

/** The text of a file at a revision, or null when the revision has no such file. */
export async function committedFile(repoPath: string, path: string, ref: string): Promise<string | null> {
  let listed: string;
  try {
    listed = await git(['-C', repoPath, 'ls-tree', '--name-only', ref, '--', path]);
  } catch (error) {
    throw new SwarmloopError(`Cannot read project environment at ${ref}: ${gitDetail(error)}`);
  }
  if (listed.trim() === '') {
    return null;
  }
  return git(['-C', repoPath, 'show', `${ref}:${path}`]);
}
