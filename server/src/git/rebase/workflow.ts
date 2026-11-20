import { SwarmloopError } from '../../core/swarmloop-error';
import type { RebaseHosts } from './types';
import { redact } from '../../config/redact';
import { codeHostAdapters } from '../../integrations/code-host/code-host-adapters';
import { git, gitDetail, gitRaw, gitStderr } from '../git';

/** Full git stderr for a rebase failure, with every host token removed. A captured rebase stderr wins over a later command. */
export function rebaseStderr(text: string, hosts: RebaseHosts, captured = ''): string {
  const body = captured.trim() ? captured : text;
  const tokens = codeHostAdapters().map((adapter) => hosts[adapter.tokenKey].trim());
  return redact(body, tokens);
}

export async function gitAt(
  cwd: string,
  repo: string,
  args: string[],
  failure: string,
  hosts?: RebaseHosts,
  captured = '',
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    return await git(['-C', cwd, ...args], env);
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
