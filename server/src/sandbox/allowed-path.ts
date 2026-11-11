import { realpathSync } from 'fs';
import { basename, dirname, join, resolve, sep } from 'path';
import type { AppConfig } from '../config/env';
import { SwarmloopError } from '../core/swarmloop-error';
import { resolveRepoRoot } from '../config/repo-root';
import { listGitProjects, resolveCheckoutPath } from '../config/checkout-path';

/** The folders a sandbox or shell may work in: the repositories the server is given and its own `worktrees/`. */
export function workRoots(config: AppConfig): string[] {
  return workRootsAt(
    resolveRepoRoot(config.env.SWARMLOOP_ROOT, __dirname),
    config.env.CHECKOUTS_ROOT,
    config.env.SWARMLOOP_REPOS,
  );
}

/** The same roots for a caller that has no `AppConfig`, such as the CLI shell. */
export function workRootsAt(base: string, checkoutsRoot: string | undefined, repos: string[]): string[] {
  return [...repoPaths(base, checkoutsRoot, repos), join(base, 'worktrees')];
}

function repoPaths(base: string, checkoutsRoot: string | undefined, repos: string[]): string[] {
  try {
    return listGitProjects(base, checkoutsRoot, repos).map((name) =>
      resolveCheckoutPath(base, checkoutsRoot, name, ''),
    );
  } catch {
    // Without a readable checkouts root there are no repositories, only `worktrees/`.
    return [];
  }
}

/** Resolves symlinks first, so a link that points out of the roots does not pass. */
export function assertInsideWork(path: string, roots: string[]): void {
  const real = realPath(path);
  const inside = roots.some((candidate) => {
    const base = realPath(candidate);
    return real === base || real.startsWith(`${base}${sep}`);
  });
  if (!inside) {
    throw new SwarmloopError('path is outside the repositories');
  }
}

/** The real path of the deepest part that exists, followed by the part that does not exist yet. */
function realPath(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(realPath(parent), basename(full));
  }
}
