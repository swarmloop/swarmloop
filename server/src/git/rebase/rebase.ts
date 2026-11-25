import { existsSync, rmSync, statSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { SwarmloopError } from '../../core/swarmloop-error';
import { promptBase } from '../base-ref';
import { allowedPaths, deniedIndexPaths, isDenied, porcelainPaths, stageSelection } from '../../git/commit-paths';
import { commitIdentity, git, gitStderr, type CommitAuthor } from '../git';
import { worktreePath } from '../../git/repo-names';
import { unmergedPaths } from './clone-index';
import { branchHasAllowedChange, clearRebaseState, readRebaseState } from './conflict';
import type { RebaseState } from './conflict';
import { baseRefFor, publishedTip, squashOffMount } from './squash';
import { ownChangeBase } from './own-change';
import { retakeSquashConflict } from './retake';
import { commitAllowed, hideDeniedWorktree, restoreHiddenWorktree } from './hidden-worktree';
import { storedBase } from './fetch';
import { atOrPast, fingerprintOf, protectRef } from './journal';
import type { JournalEntry, RebaseJournal } from './journal';
import { gitAt, gitRawAt, rebaseStderr } from './workflow';
import { forRepo } from '../per-repo';
import { withWorktree } from '../worktree-lock';

/** Set while a conflict rebase still has to be resolved, then reviewed on the new diff. */
export const REBASE_CONFLICT = 'rebase_conflict';

import type { RebaseHosts, RebaseRepoInput, RebaseStop } from './types';
export type { RebaseStop } from './types';

/** Squash each feature branch onto the fetched base. Stop at the first conflict. */
export async function rebaseFeatureRepos(input: RebaseRepoInput): Promise<RebaseStop> {
  promptBase(input.prompt);
  const stored = await input.journal.open();
  const leases: { repo: string; tip: string | null }[] = [];
  for (const repo of input.repos) {
    const cwd = checkout(input.root, input.key, repo);
    const entry = stored[repo];
    const branch = forRepo(input.branch, repo);
    const tip = entry ? entry.expectedRemoteTip : await publishedTip(cwd, branch);
    const outcome = await withWorktree(cwd, () =>
      rebaseFeatureRepo({
        cwd,
        repo,
        key: input.key,
        branch,
        prompt: input.prompt,
        denied: input.denied,
        message: forRepo(input.message, repo),
        author: input.author,
        hosts: input.hosts,
        journal: input.journal,
        tips: input.tips?.[repo] ?? [],
        tip,
        entry,
        onBase: input.onBase,
      }),
    );
    if (outcome) {
      return outcome;
    }
    leases.push({ repo, tip });
  }
  return { kind: 'clean', leases };
}

/** Parked rebase: the state file is present and the index is still unmerged. */
export async function parkedConflict(
  cwd: string,
  repo: string,
  prompt: string | null,
  entry: JournalEntry | undefined,
): Promise<RebaseStop | null> {
  const state = await readRebaseState(cwd, repo);
  // A conflict the old squash parked has no `ownBase`: it is taken again by the rule, not handed to an agent.
  if (!state || (entry && !entry.ownBase)) {
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

interface RepoMove {
  cwd: string;
  repo: string;
  key: string;
  branch: string;
  prompt: string | null;
  denied: string[];
  message: string;
  author?: CommitAuthor | null;
  hosts: RebaseHosts;
  journal: RebaseJournal;
  tips: string[];
  tip: string | null;
  entry: JournalEntry | undefined;
  onBase?: RebaseRepoInput['onBase'];
}

async function rebaseFeatureRepo(input: RepoMove): Promise<RebaseStop | null> {
  const { cwd, repo, journal } = input;
  const { entry } = input;
  if (entry && atOrPast(entry, 'applied')) {
    // Applied before a restart or a retry: never apply it twice.
    if (entry.checkpoint !== 'completed') {
      input.onBase?.(repo, entry.baseSha);
    }
    return null;
  }
  const state = await readRebaseState(cwd, repo);
  if (state) {
    const settled = await settleParked(input, state);
    if (settled) return settled.stop;
  }
  if (entry?.checkpoint === 'applying' && entry.squashSha && (await headOf(cwd, repo)) === entry.squashSha) {
    // The reset to the squash landed and the checkpoint did not: finish it.
    await restoreHiddenWorktree(cwd, repo, input.hosts, '');
    await journal.advance(repo, 'applied', { fingerprint: await fingerprintOf(cwd) });
    return null;
  }
  const stored = entry && entry.checkpoint !== 'prepared' ? entry.baseSha : '';
  if (!entry || entry.checkpoint === 'prepared') {
    await startEntry(input, { baseSha: '', checkpoint: 'prepared' });
  }
  await abortMountedRebase(cwd, repo, input.hosts);
  const current = await gitAt(cwd, repo, ['branch', '--show-current'], 'branch failed');
  if (current !== input.branch) {
    throw new SwarmloopError(`${repo} branch is missing`);
  }
  const porcelain = await gitRawAt(cwd, repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const deniedDirty = porcelainPaths(porcelain).filter((path) => isDenied(path, input.denied));
  if (
    deniedDirty.length > 0 &&
    allowedPaths(repo, porcelain, input.denied).length === 0 &&
    !(await branchHasAllowedChange(cwd, input.prompt, input.denied))
  ) {
    throw new SwarmloopError(`${repo} rebase failed: ${deniedDirty[0]}`);
  }
  await commitAllowed(cwd, repo, input.denied, input.message, input.author);
  const after = await gitRawAt(cwd, repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const leftover = porcelainPaths(after).find((path) => !isDenied(path, input.denied));
  if (leftover) {
    throw new SwarmloopError(`${repo} rebase failed: ${leftover}`);
  }
  // The base is fetched once. A retry applies to the stored SHA, never to a moving `origin/<main>`.
  const base = stored
    ? await baseRefFor(cwd, input.prompt, stored)
    : await storedBase(cwd, repo, input.prompt, input.hosts, 'rebase');
  const baseSha = await gitAt(cwd, repo, ['rev-parse', '--verify', `${stored || base}^{commit}`], 'base failed');
  if (base !== 'HEAD') {
    input.onBase?.(repo, baseSha);
  }
  const ownBase = await ownBaseOf(input, baseSha);
  await journal.advance(repo, 'changes_preserved', {
    baseSha,
    ownBase,
    oldHead: await headOf(cwd, repo),
    fingerprint: await fingerprintOf(cwd),
  });
  await hideDeniedWorktree(cwd, repo, input.denied, input.hosts, input.author);
  await journal.advance(repo, 'applying', { fingerprint: await fingerprintOf(cwd) });
  const scratch = await mkdtemp(join(tmpdir(), 'swarmloop-rebase-'));
  const tmp = join(scratch, 'clone');
  let hidden = true;
  try {
    const outcome = await squashOffMount({ ...input, base: baseSha, ownBase, tmp });
    try {
      await restoreHiddenWorktree(cwd, repo, input.hosts, '');
    } catch (error) {
      // Restore cannot apply onto an unmerged index. The conflict still returns; resume restores this ref.
      if (outcome?.kind !== 'conflict') {
        throw error;
      }
    }
    hidden = false;
    if (outcome?.kind === 'conflict') {
      await journal.advance(repo, 'conflict');
      return { ...outcome, base };
    }
    await journal.advance(repo, 'applied', { fingerprint: await fingerprintOf(cwd) });
    return outcome;
  } catch (error) {
    if (hidden) {
      try {
        await restoreHiddenWorktree(cwd, repo, input.hosts, '');
      } catch {
        // Restore failed. Report the rebase error.
      }
    }
    throw error;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * A rebase state is parked in the worktree. Finishing it ends the move (its stop is returned). A conflict the squash
 * from git's merge base parked (an entry with no `ownBase`) is cleared instead, and null says the move runs again by the rule.
 */
async function settleParked(input: RepoMove, state: RebaseState): Promise<{ stop: RebaseStop | null } | null> {
  const { cwd, repo, journal, entry } = input;
  input.onBase?.(repo, state.baseSha);
  if (!entry) {
    await startEntry(input, { baseSha: state.baseSha, checkpoint: 'conflict' });
  }
  if (entry && !entry.ownBase) {
    await retakeSquashConflict({ ...input, entry });
    return null;
  }
  const resumed = await resumeRebase({ ...input, state });
  await journal.advance(repo, 'applied', { fingerprint: await fingerprintOf(cwd) });
  return { stop: resumed };
}

/** What a retried move measured the run's own change from stays; a new move measures it from the tips the run stood on. */
async function ownBaseOf(input: RepoMove, baseSha: string): Promise<string> {
  return input.entry?.ownBase ?? (await ownChangeBase(input.cwd, input.tips, baseSha));
}

/** The entry of a rebase that starts now, written before the first change. */
async function startEntry(
  input: { cwd: string; repo: string; branch: string; journal: RebaseJournal; tip: string | null },
  start: Pick<JournalEntry, 'baseSha' | 'checkpoint'>,
): Promise<void> {
  await input.journal.put(input.repo, {
    path: input.cwd,
    branch: input.branch,
    oldHead: await headOf(input.cwd, input.repo),
    fingerprint: await fingerprintOf(input.cwd),
    protectRef: protectRef(input.branch),
    expectedRemoteTip: input.tip,
    ...start,
  });
}

function headOf(cwd: string, repo: string): Promise<string> {
  return gitAt(cwd, repo, ['rev-parse', 'HEAD'], 'rebase failed');
}

async function resumeRebase(input: {
  cwd: string;
  repo: string;
  branch: string;
  denied: string[];
  author?: CommitAuthor | null;
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
  const identity = await commitIdentity(input.cwd, input.author);
  await gitAt(
    input.cwd,
    input.repo,
    [...identity.args, 'commit', '--no-verify', '-m', input.state.message],
    'rebase failed',
    input.hosts,
    '',
    identity.env,
  );
  await clearRebaseState(input.cwd);
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
