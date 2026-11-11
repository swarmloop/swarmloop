import { testEnv } from '../../config/env.spec-helpers';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { FetchFailed } from '../../core/swarmloop-error';
import type { CodeHost } from './code-host';
import { GithubCodeHost } from './github/github-code-host';
import { GitlabCodeHost } from './gitlab/gitlab-code-host';

const TOKEN = 'super-secret-token';

interface Seen {
  method: string;
  url: string;
  body: string;
}

/** A fake host: each route answers by the first part of the url that matches. */
function fakeHost(routes: Record<string, { status?: number; body: unknown }>): Seen[] {
  const seen: Seen[] = [];
  global.fetch = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    seen.push({ method: init?.method ?? 'GET', url: String(url), body: init?.body ?? '' });
    const route = Object.entries(routes).find(([part]) => String(url).includes(part))?.[1] ?? { status: 404, body: {} };
    const status = route.status ?? 200;
    return {
      status,
      ok: status < 300,
      url: String(url),
      headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
      arrayBuffer: async () => Buffer.from(JSON.stringify(route.body)),
    };
  }) as unknown as typeof fetch;
  return seen;
}

const github = (): CodeHost =>
  new GithubCodeHost(testEnv({ GITHUB_BASE_URL: 'https://github.com', GITHUB_TOKEN: TOKEN }), new FakeClock());
const gitlab = (): CodeHost =>
  new GitlabCodeHost(testEnv({ GITLAB_BASE_URL: 'https://gitlab.example', GITLAB_TOKEN: TOKEN }), new FakeClock());

describe('github repositories', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });

  it('lists the repositories the token can push to and says whether a next page may exist', async () => {
    const seen = fakeHost({
      '/user/repos': {
        body: [
          {
            name: 'demo',
            owner: { login: 'acme' },
            private: true,
            default_branch: 'trunk',
            permissions: { push: true },
          },
          { name: 'docs', owner: { login: 'acme' }, private: false, permissions: { push: false } },
          { name: 'site', owner: { login: 'me' }, private: false, visibility: 'public', permissions: { push: true } },
        ],
      },
    });
    const page = await github().listRepositories(2);
    expect(seen[0]?.url).toBe(
      'https://api.github.com/user/repos?affiliation=owner,collaborator,organization_member&per_page=100&page=2',
    );
    expect(page.repositories).toEqual([
      { host: 'github', owner: 'acme', name: 'demo', visibility: 'private', defaultBranch: 'trunk' },
      { host: 'github', owner: 'me', name: 'site', visibility: 'public', defaultBranch: 'main' },
    ]);
    expect(page.more).toBe(false);
  });

  it('asks for the next page when a page is full', async () => {
    fakeHost({
      '/user/repos': {
        body: Array.from({ length: 100 }, (_, index) => ({ name: `r${index}`, owner: { login: 'me' } })),
      },
    });
    expect((await github().listRepositories(1)).more).toBe(true);
  });

  it('offers the account and the organizations the user may create in', async () => {
    fakeHost({
      '/user/memberships/orgs': {
        body: [
          { role: 'admin', organization: { login: 'acme' } },
          { role: 'member', organization: { login: 'closed' } },
          { role: 'member', organization: { login: 'open', members_can_create_repositories: true } },
        ],
      },
      '/user': { body: { login: 'me' } },
    });
    const { owners } = await github().listOwners();
    expect(owners.map((owner) => [owner.login, owner.kind])).toEqual([
      ['me', 'user'],
      ['acme', 'organization'],
      ['open', 'organization'],
    ]);
  });

  it('creates a private repository with an initial commit unless it is asked to be public', async () => {
    const row = { name: 'demo', owner: { login: 'acme' }, private: true, default_branch: 'main' };
    const seen = fakeHost({
      '/orgs/acme/repos': { status: 201, body: row },
      '/user/repos': { status: 201, body: row },
    });
    const owner = { host: 'github' as const, login: 'acme', kind: 'organization' as const };
    const created = await github().createRepository({ owner, name: 'demo', isPublic: false });
    expect(created.repository.visibility).toBe('private');
    expect(seen[0]?.url).toBe('https://api.github.com/orgs/acme/repos');
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({ name: 'demo', private: true, auto_init: true });
    await github().createRepository({ owner: { ...owner, login: 'me', kind: 'user' }, name: 'demo', isPublic: true });
    expect(seen[1]?.url).toBe('https://api.github.com/user/repos');
    expect(JSON.parse(seen[1]?.body ?? '{}')).toMatchObject({ private: false, auto_init: true });
  });

  it('names the host message and the permission needed when the token may not create', async () => {
    fakeHost({ '/user/repos': { status: 403, body: { message: 'Resource not accessible by personal access token' } } });
    const owner = { host: 'github' as const, login: 'me', kind: 'user' as const };
    const failure = await github()
      .createRepository({ owner, name: 'demo', isPublic: false })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FetchFailed);
    expect((failure as Error).message).toBe(
      'Resource not accessible by personal access token (needs repo scope (public_repo for public repositories only))',
    );
    expect(JSON.stringify((failure as FetchFailed).httpCalls)).not.toContain(TOKEN);
  });

  it('clones from a url without the token and authenticates through env', () => {
    expect(github().cloneUrl('acme/demo')).toBe('https://github.com/acme/demo.git');
    const env = github().cloneEnv();
    expect(env.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from(`x-access-token:${TOKEN}`).toString('base64')}`,
    );
    expect(github().cloneUrl('acme/demo')).not.toContain(TOKEN);
  });
});

describe('gitlab repositories', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });

  it('lists projects of a developer and keeps the namespace path as owner', async () => {
    const seen = fakeHost({
      '/api/v4/projects': {
        body: [{ path: 'demo', namespace: { full_path: 'group/sub' }, visibility: 'internal', default_branch: 'dev' }],
      },
    });
    const page = await gitlab().listRepositories(1);
    expect(seen[0]?.url).toBe(
      'https://gitlab.example/api/v4/projects?membership=true&min_access_level=30&per_page=100&page=1',
    );
    expect(page.repositories).toEqual([
      { host: 'gitlab', owner: 'group/sub', name: 'demo', visibility: 'private', defaultBranch: 'dev' },
    ]);
  });

  it('offers the user namespace and the groups that allow creating', async () => {
    fakeHost({
      '/api/v4/groups': {
        body: [
          { id: 5, full_path: 'team', project_creation_level: 'developer' },
          { id: 6, full_path: 'locked', project_creation_level: 'noone' },
        ],
      },
      '/api/v4/user': { body: { username: 'me', namespace_id: 3 } },
    });
    const { owners } = await gitlab().listOwners();
    expect(owners).toEqual([
      { host: 'gitlab', login: 'me', kind: 'user', id: 3 },
      { host: 'gitlab', login: 'team', kind: 'group', id: 5 },
    ]);
  });

  it('creates a private project with a readme unless it is asked to be public', async () => {
    const seen = fakeHost({
      '/api/v4/projects': {
        status: 201,
        body: { path: 'demo', namespace: { full_path: 'team' }, visibility: 'private' },
      },
    });
    const owner = { host: 'gitlab' as const, login: 'team', kind: 'group' as const, id: 5 };
    await gitlab().createRepository({ owner, name: 'demo', isPublic: false });
    expect(JSON.parse(seen[0]?.body ?? '{}')).toEqual({
      name: 'demo',
      path: 'demo',
      visibility: 'private',
      initialize_with_readme: true,
      namespace_id: 5,
    });
    await gitlab().createRepository({ owner, name: 'demo', isPublic: true });
    expect(JSON.parse(seen[1]?.body ?? '{}')).toMatchObject({ visibility: 'public' });
  });

  it('names the host message and the permission needed when the token may not create', async () => {
    fakeHost({ '/api/v4/projects': { status: 403, body: { message: '403 Forbidden' } } });
    const owner = { host: 'gitlab' as const, login: 'team', kind: 'group' as const, id: 5 };
    await expect(gitlab().createRepository({ owner, name: 'demo', isPublic: false })).rejects.toThrow(
      '403 Forbidden (needs api scope and the Developer role)',
    );
  });

  it('clones from a url without the token and authenticates through env', () => {
    expect(gitlab().cloneUrl('team/demo')).toBe('https://gitlab.example/team/demo.git');
    expect(gitlab().cloneEnv().GIT_CONFIG_VALUE_0).toContain(Buffer.from(`oauth2:${TOKEN}`).toString('base64'));
  });
});
