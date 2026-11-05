import { existsSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SwarmloopError } from '../../core/swarmloop-error';
import { originRef, promptBase } from '../base-ref';
import { isDenied } from '../../git/commit-paths';
import { git, gitMissing, gitRaw, gitStderr } from '../git';
import type { RebaseHosts, RebaseStop } from './types';
import {
  cloneArgs,
  copiedDestination,
  cloneUnmerged,
  gitStdin,
  importCloneBlobs,
  loadCloneIndex,
  parseStageList,
  readCloneFiles,
  removeCopiedPath,
} from './clone-index';
import { resolveGitPath } from './hidden-worktree';
import { gitAt, gitRawAt, rebaseStderr } from './workflow';
import { unmergedPaths } from './clone-index';

export interface RebaseState {
  baseSha: string;
  message: string;
}

/** True when this branch already changes an allowed path relative to the local base. A denied-only branch does not. */
export async function branchHasAllowedChange(cwd: string, prompt: string | null, denied: string[]): Promise<boolean> {
  const wanted = promptBase(prompt);
  const names = wanted.kind === 'named' ? [wanted.name] : ['main', 'master'];
  let base: string | null = null;
  for (const name of names) {
    const ref = originRef(name);
    try {
      await git(['-C', cwd, 'rev-parse', '--verify', '--quiet', ref]);
      base = ref;
      break;
    } catch (error) {
      if (!gitMissing(error)) {
        throw error;
      }
    }
  }
  if (!base) {
    return false;
  }
  try {
    const listed = await gitRaw(['-C', cwd, 'diff', '--name-only', '-z', `${base}...HEAD`]);
    return listed.split('\0').some((path) => path.length > 0 && !isDenied(path, denied));
  } catch {
    return false;
  }
}

export async function landConflict(input: {
  cwd: string;
  tmp: string;
  repo: string;
  branch: string;
  denied: string[];
  base: string;
  baseSha: string;
  message: string;
  hosts: RebaseHosts;
  stderr: string;
}): Promise<RebaseStop> {
  const unmerged = await cloneUnmerged(input.tmp, input.repo, input.hosts);
  const blocked = unmerged.find((file) => isDenied(file, input.denied));
  if (blocked) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${blocked}`);
  }
  let stageList = '';
  try {
    stageList = await gitRaw(cloneArgs(input.tmp, ['ls-files', '--stage', '-z']));
  } catch (error) {
    throw new SwarmloopError(`${input.repo} rebase failed: ${rebaseStderr(gitStderr(error), input.hosts)}`);
  }
  const entries = parseStageList(stageList);
  const files = readCloneFiles(
    input.tmp,
    entries.map((entry) => entry.path),
  );
  const oldTip = await gitAt(input.cwd, input.repo, ['rev-parse', 'HEAD'], 'rebase failed', input.hosts);
  await gitAt(
    input.cwd,
    input.repo,
    ['update-ref', `refs/swarmloop/pre-rebase/${input.branch}`, oldTip],
    'rebase failed',
    input.hosts,
  );
  await resetHard(input.cwd, input.repo, input.hosts, input.baseSha);
  for (const [path, file] of files) {
    const full = copiedDestination(input.cwd, path);
    removeCopiedPath(full);
    if (file.kind === 'link') {
      symlinkSync(file.target, full);
    } else {
      writeFileSync(full, file.bytes);
    }
  }
  const present = new Set(entries.map((entry) => entry.path));
  const tracked = (await gitRawAt(input.cwd, input.repo, ['ls-files', '-z']))
    .split('\0')
    .filter((path) => path.length > 0);
  const removed = tracked.filter((path) => !present.has(path));
  for (const path of removed) {
    removeCopiedPath(join(input.cwd, path));
  }
  await importCloneBlobs(input.cwd, input.tmp, input.repo, input.hosts, entries);
  await loadCloneIndex(input.cwd, input.repo, input.hosts, entries, removed);
  const target = await resolveGitPath(input.cwd, 'swarmloop-rebase');
  if (!target) {
    throw new SwarmloopError(`${input.repo} rebase failed: swarmloop-rebase`);
  }
  writeFileSync(target, `${input.baseSha}\n${input.message}\n`);
  return {
    kind: 'conflict',
    repo: input.repo,
    files: await unmergedPaths(input.cwd),
    stderr: rebaseStderr(input.stderr, input.hosts),
    base: input.base,
    commit: input.message,
  };
}

/** `--no-skip-worktree` is ignored when `--no-assume-unchanged` is in the same call. */
export async function resetHard(cwd: string, repo: string, hosts: RebaseHosts, rev: string): Promise<void> {
  const raw = await gitRawAt(cwd, repo, ['ls-files', '-z']);
  if (raw.length > 0) {
    await gitStdin(cwd, repo, hosts, ['update-index', '--no-skip-worktree', '-z', '--stdin'], raw);
    await gitStdin(cwd, repo, hosts, ['update-index', '--no-assume-unchanged', '-z', '--stdin'], raw);
  }
  await gitAt(cwd, repo, ['reset', '--hard', rev], 'rebase failed', hosts);
}

export async function readRebaseState(cwd: string, repo: string): Promise<RebaseState | null> {
  const target = await resolveGitPath(cwd, 'swarmloop-rebase');
  if (!target || !existsSync(target)) {
    return null;
  }
  const text = readFileSync(target, 'utf8');
  const split = text.indexOf('\n');
  if (split < 0) {
    throw new SwarmloopError(`${repo} rebase failed: swarmloop-rebase`);
  }
  const baseSha = text.slice(0, split).trim();
  let message = text.slice(split + 1);
  if (message.endsWith('\n')) {
    message = message.slice(0, -1);
  }
  if (message.endsWith('\r')) {
    message = message.slice(0, -1);
  }
  if (!baseSha) {
    throw new SwarmloopError(`${repo} rebase failed: swarmloop-rebase`);
  }
  return { baseSha, message };
}
