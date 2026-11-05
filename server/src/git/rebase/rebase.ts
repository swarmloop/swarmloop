import { existsSync, rmSync, statSync, unlinkSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { SwarmloopError } from '../../core/swarmloop-error';
import { promptBase } from '../base-ref';
import { allowedPaths, deniedIndexPaths, isDenied, porcelainPaths, stageSelection } from '../../git/commit-paths';
import { authorArgs, git, gitStderr } from '../git';
import { worktreePath } from '../../git/repo-names';
import { unmergedPaths } from './clone-index';
import { branchHasAllowedChange, readRebaseState } from './conflict';
import type { RebaseState } from './conflict';
import { baseRefFor, publishedTip, squashOffMount } from './squash';
import { commitAllowed, hideDeniedWorktree, resolveGitPath, restoreHiddenWorktree } from './hidden-worktree';
import { storedBase } from './fetch';
import { gitAt, gitRawAt, rebaseStderr } from './workflow';

/** Set while a conflict rebase still has to be resolved, then reviewed on the new diff. */
export const REBASE_CONFLICT = 'rebase_conflict';

import type { RebaseHosts, RebaseRepoInput, RebaseStop } from './types';
export type { RebaseStop } from './types';

/** Squash each feature branch onto the fetched base. Stop at the first conflict. */
export async function rebaseFeatureRepos(input: RebaseRepoInput): Promise<RebaseStop> {
  promptBase(input.prompt);
  const leases: { repo: string; tip: string | null }[] = [];
  for (const repo of input.repos) {
    const cwd = checkout(input.root, input.key, repo);
    const tip = await publishedTip(cwd, input.branch);
    const outcome = await rebaseFeatureRepo({
      cwd,
      repo,
      branch: input.branch,
      prompt: input.prompt,
      denied: input.denied,
      message: input.message,
      hosts: input.hosts,
      onBase: input.onBase,
    });
    if (outcome) {
      return outcome;
    }
    leases.push({ repo, tip });
  }
  return { kind: 'clean', leases };
}

/** Parked rebase: the state file is present and the index is still unmerged. */
export async function parkedConflict(cwd: string, repo: string, prompt: string | null): Promise<RebaseStop | null> {
  const state = await readRebaseState(cwd, repo);
  if (!state) {
    return null;
  }
  const files = await unmergedPaths(cwd);
  if (files.length === 0) {
    return null;
  }
  return {
    kind: 'conflict',
    repo,
    files,
    stderr: '',
    base: await baseRefFor(cwd, prompt, state.baseSha),
    commit: state.message,
  };
}

async function rebaseFeatureRepo(input: {
  cwd: string;
  repo: string;
  branch: string;
  prompt: string | null;
  denied: string[];
  message: string;
  hosts: RebaseHosts;
  onBase?: RebaseRepoInput['onBase'];
}): Promise<RebaseStop | null> {
  const state = await readRebaseState(input.cwd, input.repo);
  if (state) {
    input.onBase?.(input.repo, state.baseSha);
    return resumeRebase({ ...input, state });
  }
  await abortMountedRebase(input.cwd, input.repo, input.hosts);
  const current = await gitAt(input.cwd, input.repo, ['branch', '--show-current'], 'branch failed');
  if (current !== input.branch) {
    throw new SwarmloopError(`${input.repo} branch is missing`);
  }
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
  if (leftover) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${leftover}`);
  }
  const base = await storedBase(input.cwd, input.repo, input.prompt, input.hosts, 'rebase');
  const baseSha = await gitAt(input.cwd, input.repo, ['rev-parse', '--verify', `${base}^{commit}`], 'base failed');
  if (base !== 'HEAD') {
    input.onBase?.(input.repo, baseSha);
  }
  await hideDeniedWorktree(input.cwd, input.repo, input.denied, input.hosts);
  const scratch = await mkdtemp(join(tmpdir(), 'swarmloop-rebase-'));
  const tmp = join(scratch, 'clone');
  let hidden = true;
  try {
    const outcome = await squashOffMount({ ...input, base: baseSha, tmp });
    try {
      await restoreHiddenWorktree(input.cwd, input.repo, input.hosts, '');
    } catch (error) {
      // Restore cannot apply onto an unmerged index. The conflict still returns; resume restores this ref.
      if (outcome?.kind !== 'conflict') {
        throw error;
      }
    }
    hidden = false;
    return outcome?.kind === 'conflict' ? { ...outcome, base } : outcome;
  } catch (error) {
    if (hidden) {
      try {
        await restoreHiddenWorktree(input.cwd, input.repo, input.hosts, '');
      } catch {
        // Restore failed. Report the rebase error.
      }
    }
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function resumeRebase(input: {
  cwd: string;
  repo: string;
  branch: string;
  denied: string[];
  hosts: RebaseHosts;
  state: RebaseState;
}): Promise<RebaseStop | null> {
  const current = await gitAt(input.cwd, input.repo, ['branch', '--show-current'], 'branch failed');
  if (current !== input.branch) {
    throw new SwarmloopError(`${input.repo} branch is missing`);
  }
  const porcelain = await gitRawAt(input.cwd, input.repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const held = deniedIndexPaths(porcelain, input.denied);
  if (held.length > 0) {
    await gitAt(input.cwd, input.repo, ['reset', '-q', 'HEAD', '--', ...held], 'rebase failed', input.hosts);
  }
  const add = stageSelection(porcelain, input.denied).add;
  if (add.length > 0) {
    await gitAt(input.cwd, input.repo, ['add', '--', ...add], 'rebase failed', input.hosts);
  }
  await gitAt(
    input.cwd,
    input.repo,
    [...(await authorArgs(input.cwd)), 'commit', '--no-verify', '-m', input.state.message],
    'rebase failed',
    input.hosts,
  );
  const target = await resolveGitPath(input.cwd, 'swarmloop-rebase');
  if (target && existsSync(target)) {
    unlinkSync(target);
  }
  await restoreHiddenWorktree(input.cwd, input.repo, input.hosts, '');
  return null;
}

async function abortMountedRebase(cwd: string, repo: string, hosts: RebaseHosts): Promise<void> {
  if (!(await gitPathExists(cwd, 'rebase-merge')) && !(await gitPathExists(cwd, 'rebase-apply'))) {
    return;
  }
  try {
    await git(['-C', cwd, 'rebase', '--abort']);
  } catch (error) {
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts)}`);
  }
}

function checkout(root: string, key: string, repo: string): string {
  const cwd = worktreePath(root, key, repo);
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new SwarmloopError(`${repo} is not a worktree`);
  }
  return cwd;
}

async function gitPathExists(cwd: string, name: string): Promise<boolean> {
  try {
    const printed = await git(['-C', cwd, 'rev-parse', '--git-path', name]);
    const target = isAbsolute(printed) ? printed : join(cwd, printed);
    return existsSync(target);
  } catch {
    return false;
  }
}
