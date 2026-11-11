import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { testEnv } from '../../config/env.spec-helpers';
import type { RemoteRepository, RepositoryOwner } from '../../contract/api';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { FetchFailed } from '../../core/swarmloop-error';
import type { CodeHost } from '../../integrations/code-host/code-host';
import type { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { RemoteRepositories } from './remote-repositories.service';

const TOKEN = 'super-secret-token';

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, stdio: 'ignore' });
}

/** A fake host. Its repositories are bare repositories on disk, so a clone reads a real one. */
function fakeHost(name: 'github' | 'gitlab', remotes: string, repositories: RemoteRepository[]) {
  const owners: RepositoryOwner[] = [{ host: name, login: 'acme', kind: 'organization' }];
  const bare = (project: string): string => join(remotes, `${name}-${project.replace('/', '-')}.git`);
  const seed = (project: string): void => {
    const work = mkdtempSync(join(tmpdir(), 'swarmloop-seed-'));
    sh(work, 'init', '-b', 'main');
    writeFileSync(join(work, 'README.md'), 'hello\n');
    sh(work, 'add', '.');
    sh(work, 'commit', '-m', 'initial');
    sh(work, 'clone', '--bare', work, bare(project));
  };
  const list = jest.fn(async () => ({ repositories, more: false, httpCalls: [] }));
  const create = jest.fn(async (draft: { owner: RepositoryOwner; name: string; isPublic: boolean }) => {
    seed(`${draft.owner.login}/${draft.name}`);
    return {
      repository: {
        host: name,
        owner: draft.owner.login,
        name: draft.name,
        visibility: draft.isPublic ? ('public' as const) : ('private' as const),
        defaultBranch: 'main',
      },
      httpCalls: [],
    };
  });
  const host = {
    name,
    selected: () => ({
      name,
      token: TOKEN,
      tokenKey: `${name.toUpperCase()}_TOKEN`,
      baseUrl: `https://${name}.example`,
    }),
    listRepositories: list,
    listOwners: async () => ({ owners, httpCalls: [] }),
    createRepository: create,
    cloneUrl: bare,
    cloneEnv: () => ({ GIT_TERMINAL_PROMPT: '0' }),
    matchesOrigin: (origin: string) => origin.includes(`${name}.example`) || origin.includes(`${name}-`),
  } as unknown as CodeHost;
  return { host, seed, list, create };
}

function harness(options: {
  repos?: string[];
  github?: RemoteRepository[];
  gitlab?: RemoteRepository[];
  token?: string;
}) {
  const base = mkdtempSync(join(tmpdir(), 'swarmloop-remote-'));
  const checkouts = join(base, 'checkouts');
  const remotes = join(base, 'remotes');
  mkdirSync(checkouts);
  mkdirSync(remotes);
  const github = fakeHost('github', remotes, options.github ?? []);
  const gitlab = fakeHost('gitlab', remotes, options.gitlab ?? []);
  const token = options.token ?? TOKEN;
  const hosts = {
    names: ['github', 'gitlab'],
    has: (name: string) => name === 'github' || name === 'gitlab',
    byName: (name: string) => (name === 'github' ? github.host : gitlab.host),
    credentials: (name: string) => ({ ...(name === 'github' ? github.host : gitlab.host).selected(), token }),
    requiredCredentials: (name: string) => {
      if (!token) {
        throw new Error(`${name.toUpperCase()}_TOKEN is missing`);
      }
    },
  } as unknown as CodeHostRegistry;
  const clock = new FakeClock();
  const saveCheckout = jest.fn(async () => undefined);
  const service = new RemoteRepositories(
    {
      env: testEnv({ CHECKOUTS_ROOT: checkouts, SWARMLOOP_ROOT: base, SWARMLOOP_REPOS: options.repos ?? [] }),
    },
    clock,
    hosts,
    { saveCheckout } as never,
  );
  return { service, checkouts, remotes, clock, github, gitlab, saveCheckout };
}

const repo = (host: 'github' | 'gitlab', owner: string, name: string): RemoteRepository => ({
  host,
  owner,
  name,
  visibility: 'private',
  defaultBranch: 'main',
});

describe('RemoteRepositories', () => {
  it('lists nothing and says why when no host has a token', async () => {
    const { service, github } = harness({ token: '' });
    const view = await service.list();
    expect(view).toEqual({
      repositories: [],
      owners: [],
      reason: 'GITHUB_TOKEN or GITLAB_TOKEN is missing',
      allowedNames: [],
    });
    expect(github.list).not.toHaveBeenCalled();
  });

  it('merges both hosts and marks the repositories that are cloned', async () => {
    const { service, checkouts, github } = harness({
      github: [repo('github', 'acme', 'demo'), repo('github', 'acme', 'other')],
      gitlab: [repo('gitlab', 'team', 'tool')],
    });
    github.seed('acme/demo');
    await service.clone('demo', 'ana');
    expect(existsSync(join(checkouts, 'demo', 'README.md'))).toBe(true);
    // The fake clones from a path; a real clone's origin is the host's url.
    sh(join(checkouts, 'demo'), 'remote', 'set-url', 'origin', 'https://github.example/acme/demo.git');
    const view = await service.list();
    expect(view.repositories.map((entry) => [entry.owner, entry.name, entry.cloned])).toEqual([
      ['acme', 'demo', true],
      ['acme', 'other', false],
      ['team', 'tool', false],
    ]);
    expect(view.owners.map((owner) => owner.host)).toEqual(['github', 'gitlab']);
  });

  it('keeps a token out of the clone config', async () => {
    const { service, checkouts, github } = harness({ github: [repo('github', 'acme', 'demo')] });
    github.seed('acme/demo');
    await service.clone('demo', null);
    expect(readFileSync(join(checkouts, 'demo', '.git', 'config'), 'utf8')).not.toContain(TOKEN);
  });

  it('refuses a name whose folder belongs to another remote, and says why', async () => {
    const { service, checkouts, github } = harness({ github: [repo('github', 'acme', 'demo')] });
    github.seed('acme/demo');
    mkdirSync(join(checkouts, 'demo'));
    sh(join(checkouts, 'demo'), 'init', '-b', 'main');
    sh(join(checkouts, 'demo'), 'remote', 'add', 'origin', 'https://elsewhere.example/x/demo.git');
    const [entry] = (await service.list()).repositories;
    expect(entry?.cloned).toBe(false);
    expect(entry?.blocked).toBe('demo already exists as a folder for https://elsewhere.example/x/demo.git');
    await expect(service.clone('demo', null)).rejects.toThrow('demo already exists as a folder for https://');
  });

  it('refuses a name that two owners share', async () => {
    const { service } = harness({
      github: [repo('github', 'acme', 'demo')],
      gitlab: [repo('gitlab', 'team', 'demo')],
    });
    await expect(service.clone('demo', null)).rejects.toThrow(
      'demo matches several repositories: acme/demo, team/demo',
    );
  });

  it('leaves out a repository whose name cannot be a checkout folder', async () => {
    const { service } = harness({ github: [repo('github', 'acme', '.github'), repo('github', 'acme', 'demo')] });
    expect((await service.list()).repositories.map((entry) => entry.name)).toEqual(['demo']);
  });

  it('leaves out and refuses a name that starts with run-', async () => {
    const { service, github } = harness({ github: [repo('github', 'acme', 'run-foo')] });
    expect((await service.list()).repositories).toEqual([]);
    await expect(service.clone('run-foo', null)).rejects.toThrow('run-foo is not a repository');
    await expect(service.create({ host: 'github', owner: 'acme', name: 'run-foo' }, null)).rejects.toThrow(
      'checkout name is invalid',
    );
    expect(github.create).not.toHaveBeenCalled();
  });

  it('serves the list from the cache for a minute', async () => {
    const { service, clock, github } = harness({ github: [repo('github', 'acme', 'demo')] });
    await service.list();
    await service.list();
    expect(github.list).toHaveBeenCalledTimes(1);
    clock.advance(61_000);
    await service.list();
    expect(github.list).toHaveBeenCalledTimes(2);
  });

  it('lists, clones and creates only the names of SWARMLOOP_REPOS', async () => {
    const { service, github } = harness({
      repos: ['demo'],
      github: [repo('github', 'acme', 'demo'), repo('github', 'acme', 'other')],
    });
    expect((await service.list()).repositories.map((entry) => entry.name)).toEqual(['demo']);
    expect((await service.list()).allowedNames).toEqual(['demo']);
    await expect(service.clone('other', null)).rejects.toThrow('other is not in SWARMLOOP_REPOS');
    await expect(service.create({ host: 'github', owner: 'acme', name: 'other' }, null)).rejects.toThrow(
      'other is not in SWARMLOOP_REPOS',
    );
    expect(github.create).not.toHaveBeenCalled();
  });

  it('creates a private repository, clones it and remembers the checkout', async () => {
    const { service, checkouts, saveCheckout, github } = harness({});
    const entry = await service.create({ host: 'github', owner: 'acme', name: 'fresh' }, 'ana');
    expect(entry).toMatchObject({ owner: 'acme', name: 'fresh', visibility: 'private', cloned: true });
    expect(github.create).toHaveBeenCalledWith(expect.objectContaining({ isPublic: false }));
    expect(existsSync(join(checkouts, 'fresh', 'README.md'))).toBe(true);
    expect(saveCheckout).toHaveBeenCalledWith('fresh', '');
  });

  it('creates a public repository only when asked and refuses an owner or a folder it cannot use', async () => {
    const { service, github } = harness({});
    await service.create({ host: 'github', owner: 'acme', name: 'open', public: true }, null);
    expect(github.create).toHaveBeenCalledWith(expect.objectContaining({ isPublic: true }));
    await expect(service.create({ host: 'github', owner: 'stranger', name: 'x1' }, null)).rejects.toThrow(
      'stranger cannot create repositories',
    );
    await expect(service.create({ host: 'github', owner: 'acme', name: 'open' }, null)).rejects.toThrow(
      'open already exists as a folder',
    );
    await expect(service.create({ host: 'github', owner: 'acme', name: '.bad' }, null)).rejects.toThrow(
      'checkout name is invalid',
    );
  });

  it('passes the host message of a refused create on', async () => {
    const { service, github } = harness({});
    github.create.mockRejectedValueOnce(new FetchFailed('Resource not accessible (needs repo scope)'));
    await expect(service.create({ host: 'github', owner: 'acme', name: 'fresh' }, null)).rejects.toThrow(
      'Resource not accessible (needs repo scope)',
    );
  });
});
