import { existsSync } from 'fs';
import { join } from 'path';
import { git, gitRaw } from '../git/git';

export interface WorktreeState {
  /** Untracked paths that git does not ignore. */
  untracked: Set<string>;
  /** Content hash of every tracked path that differs from HEAD. */
  modified: Map<string, string>;
}

/** What `git status` shows in the worktree right now. */
export async function worktreeState(worktree: string): Promise<WorktreeState> {
  const raw = await gitRaw(['-C', worktree, 'status', '--porcelain', '-z', '--untracked-files=all']);
  const entries = raw.split('\0').filter((entry) => entry !== '');
  const untracked = new Set<string>();
  const changed: string[] = [];
  for (let at = 0; at < entries.length; at += 1) {
    const entry = entries[at] ?? '';
    const path = entry.slice(3);
    if (entry.startsWith('??')) {
      untracked.add(path);
      continue;
    }
    changed.push(path);
    if (/[RC]/.test(entry.slice(0, 2))) {
      at += 1;
    }
  }
  const present = changed.filter((path) => existsSync(join(worktree, path)));
  const hashes = present.length === 0 ? [] : (await git(['-C', worktree, 'hash-object', '--', ...present])).split('\n');
  const modified = new Map(changed.map((path) => [path, 'deleted']));
  present.forEach((path, index) => modified.set(path, hashes[index] ?? ''));
  return { untracked, modified };
}

/** Tracked paths whose content is not what it was before. */
export function changedSince(before: WorktreeState, after: WorktreeState): string[] {
  return [...after.modified].filter(([path, hash]) => before.modified.get(path) !== hash).map(([path]) => path);
}

/** Untracked paths that were not there before. */
export function createdSince(before: WorktreeState, after: WorktreeState): string[] {
  return [...after.untracked].filter((path) => !before.untracked.has(path));
}
