import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import { copyMainWithOrigin, git } from '../../testing/git-fixture';
import { RepositoryOrigins } from './repository-origins';

describe('RepositoryOrigins', () => {
  let base: string;
  let origins: RepositoryOrigins;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'swarmloop-origins-'));
    const checkouts = join(base, 'checkouts');
    origins = new RepositoryOrigins(new AppConfig(testEnv({ SWARMLOOP_ROOT: base, CHECKOUTS_ROOT: checkouts })));
    copyMainWithOrigin(checkouts, 'web');
  });

  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('reads the origin and its project from the checkout', async () => {
    git(join(base, 'checkouts', 'web'), ['remote', 'set-url', 'origin', 'https://code.example/acme/web.git']);

    await expect(origins.of('web')).resolves.toEqual({
      origin: 'https://code.example/acme/web.git',
      project: 'acme/web',
    });
  });

  it('names an unknown repository', async () => {
    await expect(origins.of('missing')).rejects.toThrow('missing is not a checkout');
  });

  it('refuses a name that is not a checkout name, so it never reaches a path', async () => {
    await expect(origins.of('../checkouts/web')).rejects.toThrow('../checkouts/web is not a checkout');
    await expect(origins.of('/etc')).rejects.toThrow('/etc is not a checkout');
  });

  it('names a repository with no origin', async () => {
    git(join(base, 'checkouts', 'web'), ['remote', 'remove', 'origin']);

    await expect(origins.of('web')).rejects.toThrow('web has no origin');
  });

  it('lists the clones with their path and origin, narrowed by the repositories, without a clone that has no origin', async () => {
    const checkouts = join(base, 'checkouts');
    copyMainWithOrigin(checkouts, 'api');
    copyMainWithOrigin(checkouts, 'bare');
    copyMainWithOrigin(checkouts, 'skipped');
    git(join(checkouts, 'web'), ['remote', 'set-url', 'origin', 'https://code.example/acme/web.git']);
    git(join(checkouts, 'api'), ['remote', 'set-url', 'origin', 'git@code.example:acme/api.git']);
    git(join(checkouts, 'bare'), ['remote', 'remove', 'origin']);
    git(join(checkouts, 'skipped'), ['remote', 'set-url', 'origin', 'https://code.example/acme/skipped.git']);
    const narrowed = new RepositoryOrigins(
      new AppConfig(
        testEnv({ SWARMLOOP_ROOT: base, CHECKOUTS_ROOT: checkouts, SWARMLOOP_REPOS: ['web', 'api', 'bare'] }),
      ),
    );

    await expect(narrowed.list()).resolves.toEqual([
      { name: 'api', path: join(checkouts, 'api'), origin: 'git@code.example:acme/api.git' },
      { name: 'web', path: join(checkouts, 'web'), origin: 'https://code.example/acme/web.git' },
    ]);
  });
});
