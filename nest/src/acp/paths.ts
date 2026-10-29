import { isAbsolute, join, relative, resolve, sep } from 'path';
import { realpathSync } from 'fs';

/** Map a host checkout into the directory Nest sees in Docker. */
export function nestCheckout(hostPath: string, repoRoot: string, checkoutsRoot: string | undefined): string {
  const configured = checkoutsRoot?.trim() ?? '';
  const hostRoot = configured && isAbsolute(configured) ? resolve(configured) : resolve(repoRoot, configured.length > 0 ? configured : '..');
  let real: string;
  let root: string;
  try {
    real = realpathSync(hostPath);
    root = realpathSync(hostRoot);
  } catch {
    return hostPath;
  }
  try {
    const work = realpathSync(join(repoRoot, 'worktrees'));
    if (real === work || real.startsWith(`${work}${sep}`)) {
      const inside = relative(work, real);
      return inside.length === 0 ? '/app/worktrees' : `/app/worktrees/${inside.split(sep).join('/')}`;
    }
  } catch {
    // The worktrees directory is created with the first feature.
  }
  if (real !== root && !real.startsWith(`${root}${sep}`)) {
    return real;
  }
  const rest = relative(root, real);
  return rest.length === 0 ? '/checkouts' : `/checkouts/${rest.split(sep).join('/')}`;
}

/** Map a path Nest stored back to a path the host Docker daemon can bind. */
export function hostCheckout(nestPath: string, repoRoot: string, checkoutsRoot: string | undefined): string {
  const configured = checkoutsRoot?.trim() ?? '';
  const hostRoot = configured && isAbsolute(configured) ? resolve(configured) : resolve(repoRoot, configured.length > 0 ? configured : '..');
  if (nestPath === '/checkouts') {
    return hostRoot;
  }
  if (nestPath.startsWith('/checkouts/')) {
    return join(hostRoot, ...nestPath.slice('/checkouts/'.length).split('/'));
  }
  if (nestPath === '/app/worktrees') {
    return join(repoRoot, 'worktrees');
  }
  if (nestPath.startsWith('/app/worktrees/')) {
    return join(repoRoot, 'worktrees', ...nestPath.slice('/app/worktrees/'.length).split('/'));
  }
  return nestPath;
}
