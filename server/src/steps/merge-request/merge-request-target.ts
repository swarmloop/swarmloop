import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail, gitMissing } from '../../git/git';

/** The commit a ref names in a worktree, or null when it has none. */
export async function ref(repo: string, path: string, name: string): Promise<string | null> {
  try {
    return await git(['-C', path, 'rev-parse', '--verify', '--quiet', name], undefined, { answers: [1] });
  } catch (error) {
    if (gitMissing(error)) {
      return null;
    }
    throw new SwarmloopError(`${repo} branch failed: ${gitDetail(error)}`);
  }
}

async function defaultBranch(path: string): Promise<string | null> {
  try {
    const name = await git(['-C', path, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], undefined, {
      answers: [128],
    });
    const branch = name.replace(/^origin\//, '');
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    return null;
  }
}

/** The branch a request aims at: the prompt's base, else the repository's own target, else its default branch. */
export async function target(repo: string, path: string, base: string | null, named: string | null): Promise<string> {
  const chosen = base ?? named;
  if (chosen) {
    return chosen;
  }
  const branch = await defaultBranch(path);
  if (branch) {
    return branch;
  }
  for (const name of ['main', 'master']) {
    if (await ref(repo, path, `refs/remotes/origin/${name}`)) {
      return name;
    }
  }
  throw new SwarmloopError('target branch is missing');
}
