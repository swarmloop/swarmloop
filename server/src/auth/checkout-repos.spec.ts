import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AppConfig } from '../config/env';
import { CheckoutRepos } from './checkout-repos';

describe('CheckoutRepos', () => {
  let base: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'swarmloop-checkout-repos-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  function checkout(name: string, origin?: string): void {
    const path = join(base, 'checkouts', name);
    mkdirSync(path, { recursive: true });
    execFileSync('git', ['init', '-q', path]);
    if (origin) {
      execFileSync('git', ['-C', path, 'remote', 'add', 'origin', origin]);
    }
  }

  let now = 0;
  const clock = { now: () => now, iso: () => '' };
  const reader = (env: Record<string, unknown> = {}) =>
    new CheckoutRepos(
      {
        env: {
          SWARMLOOP_ROOT: base,
          CHECKOUTS_ROOT: join(base, 'checkouts'),
          SWARMLOOP_REPOS: [],
          GITHUB_BASE_URL: '',
          GITLAB_BASE_URL: '',
          ...env,
        },
      } as unknown as AppConfig,
      clock,
    );
  const repos = (env: Record<string, unknown> = {}) => reader(env).list();

  it('reads host, owner and name from https and ssh origins, with a nested GitLab group', async () => {
    checkout('a', 'https://github.com/acme/site.git');
    checkout('b', 'git@github.com:acme/api.git');
    checkout('c', 'https://gitlab.com/team/dev/tool.git');
    expect(await repos()).toEqual([
      { host: 'github', owner: 'acme', name: 'site' },
      { host: 'github', owner: 'acme', name: 'api' },
      { host: 'gitlab', owner: 'team/dev', name: 'tool' },
    ]);
  });

  it('reads the checkouts once for a short time, then again', async () => {
    checkout('a', 'https://github.com/acme/site.git');
    const reading = reader();
    expect(await reading.list()).toHaveLength(1);
    checkout('b', 'https://github.com/acme/api.git');
    expect(await reading.list()).toHaveLength(1);
    now = 60_000;
    expect(await reading.list()).toHaveLength(2);
  });

  it('is narrowed by SWARMLOOP_REPOS', async () => {
    checkout('a', 'https://github.com/acme/site.git');
    checkout('b', 'https://github.com/acme/api.git');
    expect(await repos({ SWARMLOOP_REPOS: ['b'] })).toEqual([{ host: 'github', owner: 'acme', name: 'api' }]);
  });

  it('skips a checkout with no origin and one on an unknown host', async () => {
    checkout('a');
    checkout('b', 'https://example.org/acme/site.git');
    checkout('c', 'https://github.com/acme/ok.git');
    expect(await repos()).toEqual([{ host: 'github', owner: 'acme', name: 'ok' }]);
  });

  it('maps the host of a custom GITHUB_BASE_URL to github', async () => {
    checkout('a', 'https://git.corp.test/acme/site.git');
    expect(await repos({ GITHUB_BASE_URL: 'https://git.corp.test' })).toEqual([
      { host: 'github', owner: 'acme', name: 'site' },
    ]);
  });
});
