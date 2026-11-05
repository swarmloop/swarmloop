import { SwarmloopError } from '../../core/swarmloop-error';
import { git, gitDetail, gitRaw, redact } from '../../git/git';

export interface Tree {
  repo: string;
  path: string;
}

export async function status(tree: Tree): Promise<string> {
  try {
    return await gitRaw(['-C', tree.path, 'status', '--porcelain=v1', '-z', '-uall']);
  } catch (error) {
    throw new SwarmloopError(`${tree.repo} status failed: ${gitDetail(error)}`);
  }
}

export async function gitAt(
  tree: Tree,
  args: string[],
  failure: string,
  env?: NodeJS.ProcessEnv,
  secret?: string,
): Promise<string> {
  try {
    return await git(['-C', tree.path, ...args], env);
  } catch (error) {
    const detail = gitDetail(error);
    const redacted = redact(detail, secret);
    throw new SwarmloopError(`${tree.repo} ${failure}: ${redacted}`);
  }
}
