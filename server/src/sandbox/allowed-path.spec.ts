import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { assertInsideWork, workRootsAt } from './allowed-path';

function layout() {
  const base = realpathSync(mkdtempSync(join(tmpdir(), 'swarmloop-allowed-')));
  const checkouts = join(base, 'checkouts');
  const swarmloop = join(base, 'swarmloop');
  for (const name of ['api', 'web']) mkdirSync(join(checkouts, name, '.git'), { recursive: true });
  mkdirSync(join(checkouts, 'private'), { recursive: true });
  mkdirSync(join(swarmloop, 'worktrees', 'run-1'), { recursive: true });
  return { base, checkouts, swarmloop };
}

describe('assertInsideWork', () => {
  it('accepts a repository, a folder inside it, and worktrees/', () => {
    const { checkouts, swarmloop } = layout();
    const roots = workRootsAt(swarmloop, checkouts, []);
    expect(() => assertInsideWork(join(checkouts, 'api'), roots)).not.toThrow();
    expect(() => assertInsideWork(join(checkouts, 'web', 'src'), roots)).not.toThrow();
    expect(() => assertInsideWork(join(swarmloop, 'worktrees', 'run-1'), roots)).not.toThrow();
  });

  it('refuses a path outside the repositories, and a folder that is not a repository', () => {
    const { base, checkouts, swarmloop } = layout();
    const roots = workRootsAt(swarmloop, checkouts, []);
    expect(() => assertInsideWork(base, roots)).toThrow('path is outside the repositories');
    expect(() => assertInsideWork(checkouts, roots)).toThrow('path is outside the repositories');
    expect(() => assertInsideWork(join(checkouts, 'private'), roots)).toThrow('path is outside the repositories');
    expect(() => assertInsideWork(join(checkouts, 'api', '..', 'private'), roots)).toThrow(
      'path is outside the repositories',
    );
  });

  it('refuses a repository that SWARMLOOP_REPOS leaves out', () => {
    const { checkouts, swarmloop } = layout();
    const roots = workRootsAt(swarmloop, checkouts, ['api']);
    expect(() => assertInsideWork(join(checkouts, 'api'), roots)).not.toThrow();
    expect(() => assertInsideWork(join(checkouts, 'web'), roots)).toThrow('path is outside the repositories');
  });

  it('refuses a symlink that escapes a repository', () => {
    const { base, checkouts, swarmloop } = layout();
    const roots = workRootsAt(swarmloop, checkouts, []);
    symlinkSync(join(swarmloop, 'worktrees'), join(checkouts, 'api', 'escape'));
    expect(() => assertInsideWork(join(checkouts, 'api', 'escape'), roots)).not.toThrow();
    symlinkSync(base, join(checkouts, 'api', 'out'));
    expect(() => assertInsideWork(join(checkouts, 'api', 'out'), roots)).toThrow('path is outside the repositories');
    expect(() => assertInsideWork(join(checkouts, 'api', 'out', 'nothing-yet'), roots)).toThrow(
      'path is outside the repositories',
    );
  });

  it('allows only worktrees/ when there is no checkouts root', () => {
    const { checkouts, swarmloop } = layout();
    const roots = workRootsAt(swarmloop, undefined, []);
    expect(() => assertInsideWork(join(checkouts, 'api'), roots)).toThrow('path is outside the repositories');
    expect(() => assertInsideWork(join(swarmloop, 'worktrees', 'run-1'), roots)).not.toThrow();
  });
});
