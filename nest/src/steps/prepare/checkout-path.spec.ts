import { mkdirSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { SwarmloopError } from '../../swarmloop-error';
import { listGitProjects, resolveCheckoutPath, storedProjects } from './checkout-path';

describe('resolveCheckoutPath', () => {
  const repoRoot = '/work/swarmloop';

  it('joins an empty path to the checkout name under a relative root', () => {
    expect(resolveCheckoutPath(repoRoot, '../', 'demo', '')).toBe(resolve(repoRoot, '../', 'demo'));
  });

  it('joins a relative stored path under the root', () => {
    expect(resolveCheckoutPath(repoRoot, '../', 'demo', 'elsewhere/demo')).toBe(resolve(repoRoot, '../', 'elsewhere/demo'));
  });

  it('keeps an absolute stored path', () => {
    expect(resolveCheckoutPath(repoRoot, '../', 'demo', '/opt/demo')).toBe('/opt/demo');
  });

  it('fails when a relative path has no root', () => {
    expect(() => resolveCheckoutPath(repoRoot, undefined, 'demo', '')).toThrow(SwarmloopError);
    expect(() => resolveCheckoutPath(repoRoot, undefined, 'demo', '')).toThrow('CHECKOUTS_ROOT is missing');
  });
});

describe('listGitProjects', () => {
  it('lists direct git folders and skips hidden, scratch, and plain directories', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-projects-'));
    mkdirSync(join(root, 'demo', '.git'), { recursive: true });
    mkdirSync(join(root, 'api', '.git'), { recursive: true });
    mkdirSync(join(root, 'plain'), { recursive: true });
    mkdirSync(join(root, '.hidden', '.git'), { recursive: true });
    mkdirSync(join(root, 'run-abc123', '.git'), { recursive: true });
    expect(listGitProjects(root, root)).toEqual(['api', 'demo']);
    expect(storedProjects('demo\napi\n')).toEqual(['demo', 'api']);
  });
});
