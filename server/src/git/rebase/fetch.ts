import { existsSync, readFileSync, writeFileSync } from 'fs';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { SwarmloopError } from '../../core/swarmloop-error';
import { originRef, promptBase } from '../base-ref';
import type { RebaseHosts } from './rebase';
import { git, gitDetail, originUrl, redact } from '../git';
import { cloneSource } from './clone-index';
import { resolveGitPath } from './hidden-worktree';

export async function storedBase(
  cwd: string,
  repo: string,
  prompt: string | null,
  hosts: RebaseHosts,
  step: 'prepare' | 'rebase',
): Promise<string> {
  const wanted = promptBase(prompt);
  const origin = await originUrl(cwd, repo, `${step} failed`);
  if (!origin) {
    if (wanted.kind === 'named') {
      throw new SwarmloopError(`${repo} has no ${originRef(wanted.name)}`);
    }
    return 'HEAD';
  }
  const names = wanted.kind === 'named' ? [wanted.name] : ['main', 'master'];
  for (const name of names) {
    if (await fetchSource(cwd, repo, origin, name, hosts, step)) {
      return originRef(name);
    }
  }
  const missing = wanted.kind === 'named' ? originRef(wanted.name) : 'origin/master';
  throw new SwarmloopError(`${repo} has no ${missing}`);
}

const checkoutFetches = new Map<string, Promise<void>>();

/** First attempt, then at most three retries when git reports `cannot lock ref`. */
const FETCH_LOCK_ATTEMPTS = 4;

function withCheckoutLock<T>(checkout: string, run: () => Promise<T>): Promise<T> {
  const previous = checkoutFetches.get(checkout) ?? Promise.resolve();
  const current = previous.then(run, run);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  checkoutFetches.set(checkout, settled);
  void settled.then(() => {
    if (checkoutFetches.get(checkout) === settled) {
      checkoutFetches.delete(checkout);
    }
  });
  return current;
}

/** Fetch one source branch. One fetch runs at a time per checkout. A missing ref tries the next candidate. A ref lock is retried. Any other fetch failure stops the step. */
async function fetchSource(
  cwd: string,
  repo: string,
  origin: string,
  name: string,
  hosts: RebaseHosts,
  step: 'prepare' | 'rebase',
): Promise<boolean> {
  const registry = registryFor(hosts);
  const auth = registry.pushAuth(origin);
  const url = auth.url;
  const refspec = `+refs/heads/${name}:refs/remotes/origin/${name}`;
  const secret = auth.token;
  if (!url && (origin.startsWith('git@') || origin.startsWith('ssh://'))) {
    throw new SwarmloopError(sshFailure(repo, origin, registry, step));
  }
  const checkout = await cloneSource(cwd);
  return withCheckoutLock(checkout, () => fetchLocked(cwd, repo, url, refspec, name, secret, step));
}

async function fetchLocked(
  cwd: string,
  repo: string,
  url: string | null,
  refspec: string,
  name: string,
  secret: string,
  step: 'prepare' | 'rebase',
): Promise<boolean> {
  for (let attempt = 0; attempt < FETCH_LOCK_ATTEMPTS; attempt += 1) {
    try {
      if (url) {
        await git(['-C', cwd, 'fetch', url, refspec], { GIT_TERMINAL_PROMPT: '0' });
        await clearFetchedToken(cwd, name, secret);
      } else {
        await git(['-C', cwd, 'fetch', 'origin', refspec], { GIT_TERMINAL_PROMPT: '0' });
      }
      return true;
    } catch (error) {
      if (error instanceof SwarmloopError) {
        throw error;
      }
      const detail = redact(gitDetail(error), secret.trim());
      if (detail.includes("couldn't find remote ref")) {
        return false;
      }
      if (detail.includes('cannot lock ref') && attempt < FETCH_LOCK_ATTEMPTS - 1) {
        continue;
      }
      throw new SwarmloopError(`${repo} ${step} failed: ${detail}`);
    }
  }
  throw new SwarmloopError(`${repo} ${step} failed`);
}

function registryFor(hosts: RebaseHosts): CodeHostRegistry {
  return CodeHostRegistry.create(hosts, hosts.clock);
}

function sshFailure(repo: string, origin: string, registry: CodeHostRegistry, step: 'prepare' | 'rebase'): string {
  const name = registry.forOrigin(origin);
  if (!name) {
    return `${repo} ${step} failed: code host is missing`;
  }
  const host = registry.credentials(name);
  if (!host.token.trim()) {
    return `${repo} ${step} failed: ${host.tokenKey} is missing`;
  }
  if (!host.baseUrl.trim()) {
    return `${repo} ${step} failed: ${host.baseKey} is missing`;
  }
  return `${repo} ${step} failed: origin is not ${host.baseKey}`;
}

/** The fetch URL stays in FETCH_HEAD and the remote-tracking reflog. Drop the token from both. */
async function clearFetchedToken(cwd: string, branch: string, secret: string): Promise<void> {
  if (!secret.trim()) {
    return;
  }
  for (const name of ['FETCH_HEAD', `logs/refs/remotes/origin/${branch}`]) {
    const target = await resolveGitPath(cwd, name);
    if (!target || !existsSync(target)) {
      continue;
    }
    const text = readFileSync(target, 'utf8');
    const cleaned = redact(text, secret.trim());
    if (cleaned !== text) {
      writeFileSync(target, cleaned);
    }
  }
}
