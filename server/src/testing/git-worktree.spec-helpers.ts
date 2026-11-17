import { mkdirSync } from 'fs';
import { git } from './git-fixture';

/** A worktree folder that is a git repository of its own, as every worktree of a run is. */
export function gitWorktree(path: string): void {
  mkdirSync(path, { recursive: true });
  git(path, ['init', '-q']);
}
