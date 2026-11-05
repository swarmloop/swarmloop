import { SwarmloopError } from '../../core/swarmloop-error';
import type { RebaseHosts } from './rebase';
import { git, gitDetail, gitRaw, gitStderr, redact } from '../git';

/** Full git stderr for a rebase failure, with both host tokens removed. A captured rebase stderr wins over a later command. */
export function rebaseStderr(text: string, hosts: RebaseHosts, captured = ''): string {
  const body = captured.trim() ? captured : text;
  return redact(redact(body, hosts.GITLAB_TOKEN.trim()), hosts.GITHUB_TOKEN.trim());
}

export async function gitAt(
  cwd: string,
  repo: string,
  args: string[],
  failure: string,
  hosts?: RebaseHosts,
  captured = '',
): Promise<string> {
  try {
    return await git(['-C', cwd, ...args]);
  } catch (error) {
    const detail =
      failure === 'rebase failed' && hosts ? rebaseStderr(gitStderr(error), hosts, captured) : gitDetail(error);
    throw new SwarmloopError(`${repo} ${failure}: ${detail}`);
  }
}

export async function gitRawAt(cwd: string, repo: string, args: string[]): Promise<string> {
  try {
    return await gitRaw(['-C', cwd, ...args]);
  } catch (error) {
    throw new SwarmloopError(`${repo} status failed: ${gitDetail(error)}`);
  }
}
