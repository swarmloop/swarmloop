import { rmSync } from 'fs';
import { rm } from 'fs/promises';
import { join } from 'path';
import type { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';

export function root(config: AppConfig): string {
  return resolveRepoRoot(config.env.SWARMLOOP_ROOT, __dirname);
}

export function runDir(config: AppConfig, key: string): string {
  return join(root(config), 'runs', key);
}

export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** The same removal without holding up the event loop, for trees as large as a worktree with its node_modules. */
export function removeTreeAsync(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
