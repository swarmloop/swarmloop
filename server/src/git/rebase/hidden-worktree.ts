import { lstatSync, rmSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { SwarmloopError } from '../../core/swarmloop-error';
import { deniedIndexPaths, isDenied, stageSelection } from '../../git/commit-paths';
import { authorArgs, git, gitMissing, gitRaw, gitStderr } from '../git';
import type { RebaseHosts } from './types';
import { gitAt, gitRawAt, rebaseStderr } from './workflow';
import { removeCopiedPath } from './clone-index';

/** Per-worktree ref for the files this run hides during rebase. */
const HIDDEN_REF = 'refs/worktree/swarmloop-rebase';

function hiddenMessage(paths: string[]): string {
  return `swarmloop-rebase\n${paths.join('\n')}\n`;
}

function hiddenPaths(message: string): string[] {
  const lines = message.split('\n');
  if ((lines[0] ?? '').trim() !== 'swarmloop-rebase') {
    return [];
  }
  return lines.slice(1).filter((line) => line.length > 0);
}

export async function restoreHiddenWorktree(
  cwd: string,
  repo: string,
  hosts: RebaseHosts,
  captured: string,
): Promise<void> {
  try {
    await git(['-C', cwd, 'rev-parse', '--verify', '--quiet', HIDDEN_REF], undefined, { answers: [1] });
  } catch (error) {
    if (gitMissing(error)) {
      return;
    }
    throw new SwarmloopError(`${repo} rebase failed: ${rebaseStderr(gitStderr(error), hosts, captured)}`);
  }
  const message = await gitAt(cwd, repo, ['log', '-1', '--format=%B', HIDDEN_REF], 'rebase failed', hosts, captured);
  let paths = hiddenPaths(message);
  const present = (await gitRaw(['-C', cwd, 'ls-tree', '-r', '--name-only', '-z', HIDDEN_REF]))
    .split('\0')
    .filter((item) => item.length > 0);
  if (paths.length === 0) {
    paths = present;
  }
  const known = new Set(present);
  const checkout = paths.filter((path) => known.has(path));
  const removed = paths.filter((path) => !known.has(path));
  if (checkout.length > 0) {
    await gitAt(
      cwd,
      repo,
      ['restore', '--source', HIDDEN_REF, '--worktree', '--', ...checkout],
      'rebase failed',
      hosts,
      captured,
    );
  }
  for (const path of removed) {
    removeCopiedPath(join(cwd, path));
  }
  await gitAt(cwd, repo, ['update-ref', '-d', HIDDEN_REF], 'rebase failed', hosts, captured);
}

export async function resolveGitPath(cwd: string, name: string): Promise<string | null> {
  try {
    const printed = await git(['-C', cwd, 'rev-parse', '--git-path', name]);
    return isAbsolute(printed) ? printed : join(cwd, printed);
  } catch {
    return null;
  }
}

export async function commitAllowed(cwd: string, repo: string, denied: string[], message: string): Promise<void> {
  const porcelain = await gitRawAt(cwd, repo, ['status', '--porcelain=v1', '-z', '-uall']);
  const held = deniedIndexPaths(porcelain, denied);
  if (held.length > 0) {
    await gitAt(cwd, repo, ['reset', '-q', 'HEAD', '--', ...held], 'commit failed');
  }
  const selection = stageSelection(porcelain, denied);
  if (selection.add.length > 0) {
    await gitAt(cwd, repo, ['add', '--', ...selection.add], 'commit failed');
  }
  if (selection.add.length === 0 && selection.staged.length === 0) {
    return;
  }
  await gitAt(cwd, repo, [...(await authorArgs(cwd)), 'commit', '--no-verify', '-m', message], 'commit failed');
}

function deniedInWorktree(porcelain: string, denied: string[]): string[] {
  return deniedAt(porcelain, denied, 1);
}

function deniedAt(porcelain: string, denied: string[], column: 0 | 1): string[] {
  const parts = porcelain.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index] ?? '';
    if (entry.length < 4) {
      continue;
    }
    const status = entry.slice(0, 2);
    const path = entry.slice(3);
    if (!path) {
      continue;
    }
    if (status.includes('R') || status.includes('C')) {
      index += 1;
    }
    const mark = status[column] ?? ' ';
    if (mark === ' ' || mark === '?' || !isDenied(path, denied)) {
      continue;
    }
    paths.push(path);
  }
  return paths;
}

export async function hideDeniedWorktree(
  cwd: string,
  repo: string,
  denied: string[],
  hosts: RebaseHosts,
): Promise<void> {
  const dirty = deniedInWorktree(await gitRawAt(cwd, repo, ['status', '--porcelain=v1', '-z', '-uall']), denied);
  if (dirty.length === 0) {
    return;
  }
  const scratch = await mkdtemp(join(tmpdir(), 'swarmloop-hide-'));
  try {
    const env = { GIT_INDEX_FILE: join(scratch, 'index') };
    await git(['-C', cwd, 'read-tree', '--empty'], env);
    const present = dirty.filter((path) => worktreeFile(join(cwd, path)));
    if (present.length > 0) {
      await git(['-C', cwd, 'update-index', '--add', '--', ...present], env);
    }
    const tree = await git(['-C', cwd, 'write-tree'], env);
    const commit = await git(['-C', cwd, 'commit-tree', tree, '-m', hiddenMessage(dirty)], env);
    await gitAt(cwd, repo, ['update-ref', HIDDEN_REF, commit], 'rebase failed', hosts, '');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  try {
    await gitAt(cwd, repo, ['checkout', 'HEAD', '--', ...dirty], 'rebase failed', hosts, '');
  } catch (error) {
    try {
      await restoreHiddenWorktree(cwd, repo, hosts, '');
    } catch {
      // The ref still holds this run's files.
    }
    throw error;
  }
}

function worktreeFile(full: string): boolean {
  try {
    const info = lstatSync(full);
    return info.isFile() || info.isSymbolicLink();
  } catch {
    return false;
  }
}
