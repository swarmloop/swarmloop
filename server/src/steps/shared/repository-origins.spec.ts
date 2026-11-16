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

  it('names a repository with no origin', async () => {
    git(join(base, 'checkouts', 'web'), ['remote', 'remove', 'origin']);

    await expect(origins.of('web')).rejects.toThrow('web has no origin');
  });
});
