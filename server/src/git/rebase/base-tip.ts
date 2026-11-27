import type { RebaseHosts } from './types';
import { storedBase } from './fetch';
import { gitAt } from './workflow';

/** The commit of the base a move would go onto, fetched the way a move fetches it. */
export async function fetchedBaseTip(
  cwd: string,
  repo: string,
  prompt: string | null,
  hosts: RebaseHosts,
): Promise<string> {
  const ref = await storedBase(cwd, repo, prompt, hosts, 'rebase');
  return gitAt(cwd, repo, ['rev-parse', '--verify', `${ref}^{commit}`], 'base failed');
}
