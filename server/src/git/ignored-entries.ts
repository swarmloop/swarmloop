import { existsSync } from 'fs';
import { join } from 'path';
import { gitSync } from './git';

/** True for a checkout and for a worktree, whose `.git` is a file. */
export function isCheckout(dir: string): boolean {
  return existsSync(join(dir, '.git'));
}

/**
 * The directories git ignores, as paths from `dir`. `gitDir` reads the rules of another git dir over
 * the files in `dir`, for files moved out of their worktree. Two git calls, however large the tree.
 */
export function ignoredDirectories(dir: string, gitDir?: string): Set<string> {
  const scope = ['-C', dir, ...(gitDir ? ['--git-dir', gitDir, '--work-tree', '.'] : [])];
  const listed = gitSync([...scope, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z']);
  // A directory holding only ignored entries is listed too, though no rule names it: ask git which ones a rule names.
  const candidates = listed.split('\0').filter((entry) => entry.endsWith('/'));
  if (candidates.length === 0) {
    return new Set();
  }
  let ignored = '';
  try {
    ignored = gitSync([...scope, 'check-ignore', '-z', '--stdin'], candidates.join('\0'));
  } catch (error) {
    if ((error as { status?: number }).status !== 1) {
      throw error;
    }
  }
  return new Set(
    ignored
      .split('\0')
      .filter(Boolean)
      .map((entry) => entry.replace(/\/$/, '')),
  );
}

/** The files git tracks in the checkout at `dir`, as paths from it, in one git call. */
export function trackedFiles(dir: string): Set<string> {
  return new Set(gitSync(['-C', dir, 'ls-files', '-z']).split('\0').filter(Boolean));
}
