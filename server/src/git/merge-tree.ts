import { git } from './git';

/** The files git cannot merge between a ref and the head of a worktree. Empty when they merge cleanly. */
export async function mergeConflicts(path: string, ref: string): Promise<string[]> {
  try {
    await git(['-C', path, 'merge-tree', '--write-tree', '--name-only', '--no-messages', ref, 'HEAD']);
    return [];
  } catch (error) {
    const out = error instanceof Error && 'stdout' in error ? String(error.stdout) : '';
    return out.split('\n').slice(1).filter(Boolean);
  }
}
