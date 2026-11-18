import { rmSync } from 'fs';
import { rm } from 'fs/promises';
import { basename, join, resolve, sep } from 'path';
import type { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { SwarmloopError } from '../core/swarmloop-error';

export function root(config: AppConfig): string {
  return resolveRepoRoot(config.env.SWARMLOOP_ROOT, __dirname);
}

export function runDir(config: AppConfig, key: string): string {
  return join(root(config), 'runs', key);
}

export function removeTree(path: string): void {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** The same removal without holding up the event loop, for trees as large as a worktree with its installed dependencies. */
export function removeTreeAsync(path: string): Promise<void> {
  return rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/** Where uploaded files wait until a message or a run takes them. */
export function uploadsDir(config: AppConfig): string {
  return join(root(config), 'data', 'uploads');
}

/**
 * The run's read-only files. It sits in the run's agent state folder (the same segments as `agentStateDir` in the
 * sandbox layer, which history may not import).
 */
export function attachmentsDir(config: AppConfig, key: string): string {
  const states = resolve(root(config), 'data', 'agent-state');
  const dir = resolve(states, key, 'attachments');
  if (basename(key) !== key || !dir.startsWith(`${states}${sep}`)) {
    throw new SwarmloopError('run key is invalid');
  }
  return dir;
}
