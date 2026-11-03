import { join } from 'path';
import type { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';

export function root(config: AppConfig): string {
  return resolveRepoRoot(config.env.SWARMLOOP_ROOT, __dirname);
}

export function runDir(config: AppConfig, key: string): string {
  return join(root(config), 'runs', key);
}
