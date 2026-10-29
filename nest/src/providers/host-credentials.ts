import { SwarmloopEnv } from '../config/env';
import { SwarmloopError } from '../swarmloop-error';
import { remoteProject } from '../steps/merge-request/merge-request-record';

export type CodeHostName = 'gitlab' | 'github';

export interface SelectedHost {
  name: CodeHostName;
  baseUrl: string;
  token: string;
  baseKey: 'GITLAB_BASE_URL' | 'GITHUB_BASE_URL';
  tokenKey: 'GITLAB_TOKEN' | 'GITHUB_TOKEN';
}

type HostEnv = Pick<SwarmloopEnv, 'GITLAB_BASE_URL' | 'GITLAB_TOKEN' | 'GITHUB_BASE_URL' | 'GITHUB_TOKEN'>;

export function codeHostFromOrigin(origin: string, gitlabBase: string, githubBase: string): CodeHostName | null {
  let host = '';
  try {
    host = remoteProject(origin).host.toLowerCase();
  } catch {
    return null;
  }
  const gitlab = baseHost(gitlabBase);
  const github = baseHost(githubBase);
  const gitlabMatch = gitlab !== null && host === gitlab;
  const githubMatch = github !== null && host === github;
  if (gitlabMatch && githubMatch) {
    throw new SwarmloopError(`${host} matches both code hosts`);
  }
  if (githubMatch) {
    return 'github';
  }
  if (gitlabMatch) {
    return 'gitlab';
  }
  return null;
}

/** One host for this call. An empty list leaves the stored name alone. */
export function assignCodeHost(run: { codeHost: string }, hosts: readonly (CodeHostName | null)[], replace: boolean): void {
  const found = [...new Set(hosts.filter((host): host is CodeHostName => host !== null))].sort();
  if (found.length > 1) {
    throw new SwarmloopError(`origins use ${found.join(' and ')}`);
  }
  const host = found[0];
  if (!host) {
    return;
  }
  if (!replace && run.codeHost && run.codeHost !== host) {
    throw new SwarmloopError(`origin is not ${run.codeHost}`);
  }
  run.codeHost = host;
}

export function selectedHost(env: HostEnv, name: string): SelectedHost {
  if (name === 'github') {
    return {
      name: 'github',
      baseUrl: env.GITHUB_BASE_URL,
      token: env.GITHUB_TOKEN,
      baseKey: 'GITHUB_BASE_URL',
      tokenKey: 'GITHUB_TOKEN',
    };
  }
  if (name === 'gitlab') {
    return {
      name: 'gitlab',
      baseUrl: env.GITLAB_BASE_URL,
      token: env.GITLAB_TOKEN,
      baseKey: 'GITLAB_BASE_URL',
      tokenKey: 'GITLAB_TOKEN',
    };
  }
  throw new SwarmloopError('code host is missing');
}

export function requireHostCredentials(env: HostEnv, name: string): SelectedHost {
  const host = selectedHost(env, name);
  if (!host.baseUrl.trim()) {
    throw new SwarmloopError(`${host.baseKey} is missing`);
  }
  if (!host.token.trim()) {
    throw new SwarmloopError(`${host.tokenKey} is missing`);
  }
  try {
    new URL(host.baseUrl);
  } catch {
    throw new SwarmloopError(`${host.baseKey} is not a url`);
  }
  return host;
}

function baseHost(base: string): string | null {
  const trimmed = base.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed).hostname.toLowerCase();
  } catch {
    return null;
  }
}
