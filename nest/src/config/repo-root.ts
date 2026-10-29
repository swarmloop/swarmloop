import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { SwarmloopError } from '../swarmloop-error';

export function resolveRepoRoot(configured: string | undefined, fromDir: string): string {
  if (configured) {
    return configured;
  }
  let dir = fromDir;
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, '.env.example')) && existsSync(join(dir, 'skills'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  throw new SwarmloopError('repo root is missing');
}
