import { existsSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { SwarmloopError } from '../../core/swarmloop-error';
import { originRef, promptBase } from '../base-ref';
import {
  allowedPaths,
  deniedIndexPaths,
  isDenied,
  porcelainPaths,
  stageSelection,
} from '../../steps/commit/commit-paths';
import type { CodeHostEnv } from '../../integrations/code-host/abstract-code-host';
import type { Clock } from '../../core/clock';
import { authorArgs, git, gitDetail, gitMissing, gitRaw, gitStderr, originUrl, redact } from '../git';
import { worktreePath } from '../../steps/shared/repo-names';
import { unmergedFromStageList, cloneSource } from './clone-index';
import { branchHasAllowedChange, readRebaseState } from './conflict';
import { commitAllowed, hideDeniedWorktree, resolveGitPath, restoreHiddenWorktree } from './hidden-worktree';
import { baseRefFor, publishedTip, squashOffMount } from './squash';

/** Set while a conflict rebase still has to be resolved, then reviewed on the new diff. */
export const REBASE_CONFLICT = 'rebase_conflict';

export interface RebaseHosts extends CodeHostEnv {
  clock: Clock;
}

export interface RebaseRepoInput {
  root: string;
  key: string;
  repos: string[];
  branch: string;
  prompt: string | null;
  denied: string[];
  message: string;
  hosts: RebaseHosts;
}

/** Clean publishes the tips captured before the fetch. Conflict names the files still in progress. */
export type RebaseStop =
  | { kind: 'clean'; leases: { repo: string; tip: string | null }[] }
  | { kind: 'conflict'; repo: string; files: string[]; stderr: string; base: string; commit: string };

export interface RebaseState {
  baseSha: string;
  message: string;
}

/** Squash each feature branch onto the fetched base. Stop at the first conflict. */
export async function rebaseFeatureRepos(input: RebaseRepoInput): Promise<RebaseStop> {
  promptBase(input.prompt);
  const leases: { repo: string; tip: string | null }[] = [];
  for (const repo of input.repos) {
    const cwd = checkout(input.root, input.key, repo);
    const tip = await publishedTip(cwd, input.branch);
    const outcome = await rebaseFeatureRepo({ ...input, cwd, repo });
    if (outcome) return outcome;
    leases.push({ repo, tip });
  }
  return { kind: 'clean', leases };
}

export async function unmergedPaths(cwd: string): Promise<string[]> {
  let raw = '';
  try {
    raw = await gitRaw(['-C', cwd, 'ls-files', '-u', '-z']);
  } catch (error) {
    if (!gitMissing(error)) throw new SwarmloopError(gitDetail(error));
  }
  return unmergedFromStageList(raw);
}

/** Parked rebase: the state file is present and the index is still unmerged. */
export async function parkedConflict(cwd: string, repo: string, prompt: string | null): Promise<RebaseStop | null> {
  const state = await readRebaseState(cwd, repo);
  if (!state) return null;
  const files = await unmergedPaths(cwd);
  if (files.length === 0) return null;
  return {
    kind: 'conflict',
    repo,
    files,
    stderr: '',
    base: await baseRefFor(cwd, prompt, state.baseSha),
    commit: state.message,
  };
}

export async function rebaseFeatureRepo(input: {
  cwd: string;
  repo: string;
  branch: string;
  prompt: string | null;
  denied: string[];
  message: string;
  hosts: RebaseHosts;
}): Promise<RebaseStop | null> {
  const state = await readRebaseState(input.cwd, input.repo);
  if (state) return resumeRebase({ ...input, state });
  await abortMountedRebase(input.cwd, input.repo, input.hosts);
  const current = await gitAt(input.cwd, input.repo, ['branch', '--show-current'], 'branch failed');
  if (current !== input.branch) throw new SwarmloopError(`${input.repo} branch is missing`);
  const porcelain = await gitRawAt(input.cwd, input.repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const deniedDirty = porcelainPaths(porcelain).filter((path) => isDenied(path, input.denied));
  if (
    deniedDirty.length > 0 &&
    allowedPaths(input.repo, porcelain, input.denied).length === 0 &&
    !(await branchHasAllowedChange(input.cwd, input.prompt, input.denied))
  ) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${deniedDirty[0]}`);
  }
  await commitAllowed(input.cwd, input.repo, input.denied, input.message);
  const after = await gitRawAt(input.cwd, input.repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const leftover = porcelainPaths(after).find((path) => !isDenied(path, input.denied));
  if (leftover) throw new SwarmloopError(`${input.repo} rebase failed: ${leftover}`);
  const base = await storedBase(input.cwd, input.repo, input.prompt, input.hosts, 'rebase');
  await hideDeniedWorktree(input.cwd, input.repo, input.denied, input.hosts);
  const scratch = await mkdtemp(join(tmpdir(), 'swarmloop-rebase-'));
  const tmp = join(scratch, 'clone');
  let hidden = true;
  try {
    const outcome = await squashOffMount({ ...input, base, tmp });
    try {
      await restoreHiddenWorktree(input.cwd, input.repo, input.hosts, '');
    } catch (error) {
      if (outcome?.kind !== 'conflict') throw error;
    }
    hidden = false;
    return outcome;
  } catch (error) {
    if (hidden) {
      try {
        await restoreHiddenWorktree(input.cwd, input.repo, input.hosts, '');
      } catch {
        /* Restore failed. Report the rebase error. */
      }
    }
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export async function resumeRebase(input: {
  cwd: string;
  repo: string;
  branch: string;
  denied: string[];
  hosts: RebaseHosts;
  state: RebaseState;
}): Promise<RebaseStop | null> {
  const current = await gitAt(input.cwd, input.repo, ['branch', '--show-current'], 'branch failed');
  if (current !== input.branch) throw new SwarmloopError(`${input.repo} branch is missing`);
  const porcelain = await gitRawAt(input.cwd, input.repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const held = deniedIndexPaths(porcelain, input.denied);
  if (held.length > 0)
    await gitAt(input.cwd, input.repo, ['reset', '-q', 'HEAD', '--', ...held], 'rebase failed', input.hosts);
  const add = stageSelection(porcelain, input.denied).add;
  if (add.length > 0) await gitAt(input.cwd, input.repo, ['add', '--', ...add], 'rebase failed', input.hosts);
  await gitAt(
    input.cwd,
    input.repo,
    [...(await authorArgs(input.cwd)), 'commit', '--no-verify', '-m', input.state.message],
    'rebase failed',
    input.hosts,
  );
  const target = await resolveGitPath(input.cwd, 'swarmloop-rebase');
  if (target && existsSync(target)) unlinkSync(target);
  await restoreHiddenWorktree(input.cwd, input.repo, input.hosts, '');
  return null;
}

export async function abortMountedRebase(cwd: string, repo: string, hosts: RebaseHosts): Promise<void> {
  if (!(await gitPathExists(cwd, 'rebase-merge')) && !(await gitPathExists(cwd, 'rebase-apply'))) return;
  try {
    await git(['-C', cwd, 'rebase', '--abort']);
  } catch (error) {
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
  }
}

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
    if (wanted.kind === 'named') throw new SwarmloopError(`${repo} has no ${originRef(wanted.name)}`);
    return 'HEAD';
  }
  const names = wanted.kind === 'named' ? [wanted.name] : ['main', 'master'];
  for (const name of names) if (await fetchSource(cwd, repo, origin, name, hosts, step)) return originRef(name);
  throw new SwarmloopError(`${repo} has no ${wanted.kind === 'named' ? originRef(wanted.name) : 'origin/master'}`);
}

const checkoutFetches = new Map<string, Promise<void>>();
const FETCH_LOCK_ATTEMPTS = 4;
function withCheckoutLock<T>(checkoutPath: string, run: () => Promise<T>): Promise<T> {
  const previous = checkoutFetches.get(checkoutPath) ?? Promise.resolve();
  const current = previous.then(run, run);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  checkoutFetches.set(checkoutPath, settled);
  void settled.then(() => {
    if (checkoutFetches.get(checkoutPath) === settled) checkoutFetches.delete(checkoutPath);
  });
  return current;
}
async function fetchSource(
  cwd: string,
  repo: string,
  origin: string,
  name: string,
  hosts: RebaseHosts,
  step: 'prepare' | 'rebase',
): Promise<boolean> {
  const registry = CodeHostRegistry.create(hosts, hosts.clock);
  const auth = registry.pushAuth(origin);
  const url = auth.url;
  const secret = auth.token;
  if (!url && (origin.startsWith('git@') || origin.startsWith('ssh://')))
    throw new SwarmloopError(sshFailure(repo, origin, registry, step));
  return withCheckoutLock(await cloneSource(cwd), () =>
    fetchLocked(cwd, repo, url, `+refs/heads/${name}:refs/remotes/origin/${name}`, name, secret, step),
  );
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
  for (let attempt = 0; attempt < FETCH_LOCK_ATTEMPTS; attempt += 1)
    try {
      if (url) {
        await git(['-C', cwd, 'fetch', url, refspec], { GIT_TERMINAL_PROMPT: '0' });
        await clearFetchedToken(cwd, name, secret);
      } else await git(['-C', cwd, 'fetch', 'origin', refspec], { GIT_TERMINAL_PROMPT: '0' });
      return true;
    } catch (error) {
      if (error instanceof SwarmloopError) throw error;
      const detail = redact(gitDetail(error), secret.trim());
      if (detail.includes("couldn't find remote ref")) return false;
      if (detail.includes('cannot lock ref') && attempt < FETCH_LOCK_ATTEMPTS - 1) continue;
      throw new SwarmloopError(`${repo} ${step} failed: ${detail}`);
    }
  throw new SwarmloopError(`${repo} ${step} failed`);
}
function sshFailure(repo: string, origin: string, registry: CodeHostRegistry, step: 'prepare' | 'rebase'): string {
  const name = registry.forOrigin(origin);
  if (!name) return `${repo} ${step} failed: code host is missing`;
  const host = registry.credentials(name);
  if (!host.token.trim()) return `${repo} ${step} failed: ${host.tokenKey} is missing`;
  if (!host.baseUrl.trim()) return `${repo} ${step} failed: ${host.baseKey} is missing`;
  return `${repo} ${step} failed: origin is not ${host.baseKey}`;
}
async function clearFetchedToken(cwd: string, branch: string, secret: string): Promise<void> {
  if (!secret.trim()) return;
  for (const name of ['FETCH_HEAD', `logs/refs/remotes/origin/${branch}`]) {
    const target = await resolveGitPath(cwd, name);
    if (!target || !existsSync(target)) continue;
    const text = readFileSync(target, 'utf8');
    const cleaned = redact(text, secret.trim());
    if (cleaned !== text) writeFileSync(target, cleaned);
  }
}
export function rebaseStderr(text: string, hosts: RebaseHosts, captured = ''): string {
  return redact(redact(captured.trim() ? captured : text, hosts.GITLAB_TOKEN.trim()), hosts.GITHUB_TOKEN.trim());
}
function checkout(root: string, key: string, repo: string): string {
  const cwd = worktreePath(root, key, repo);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new SwarmloopError(`${repo} is not a worktree`);
  return cwd;
}
async function gitPathExists(cwd: string, name: string): Promise<boolean> {
  try {
    const target = await resolveGitPath(cwd, name);
    return !!target && existsSync(target);
  } catch {
    return false;
  }
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
