import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { redact } from '../../config/redact';
import { testEnv } from '../../config/env.spec-helpers';
import { registerSecretSource } from '../../core/secret-sources';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import type { AppFlow, AppSource } from './login-provider';
import type { CodeHostAdapter } from './code-host-adapter';
import { codeHostAdapters } from './code-host-adapters';
import { fakeResponse, fakeThirdAdapter, fakeThirdScript, type HostScript } from './fake-third/fake-third.spec-helpers';
import { instantBackoff } from '../instant-backoff.spec-helpers';

const SCRIPTS: Record<string, HostScript> = {
  github: {
    base: 'https://github.example',
    paths: {
      token: '/login/oauth/access_token',
      user: '/api/v3/user',
      groups: '/api/v3/user/orgs',
      repo: '/api/v3/repos/acme/demo',
    },
    owner: 'octo',
    avatarUrl: 'https://github.example/avatars/octo.png',
    groups: ['acme', 'tools'],
    userBody: () => ({ login: 'octo', avatar_url: 'https://github.example/avatars/octo.png' }),
    groupsBody: () => [{ login: 'acme' }, { login: 'tools' }],
    repoBody: (push) => ({ permissions: { push } }),
  },
  gitlab: {
    base: 'https://gitlab.example',
    paths: {
      token: '/oauth/token',
      user: '/api/v4/user',
      groups: '/api/v4/groups',
      repo: '/api/v4/projects/acme%2Fdemo',
    },
    owner: 'tanuki',
    avatarUrl: 'https://gitlab.example/avatars/tanuki.png',
    groups: ['acme', 'acme/tools'],
    userBody: () => ({ username: 'tanuki', avatar_url: 'https://gitlab.example/avatars/tanuki.png' }),
    groupsBody: () => [{ full_path: 'acme' }, { full_path: 'acme/tools' }],
    repoBody: (push) => ({ permissions: { project_access: { access_level: push ? 40 : 10 } } }),
  },
  [fakeThirdAdapter.name]: fakeThirdScript,
};

interface Subject {
  name: string;
  adapter: CodeHostAdapter;
  script: HostScript;
}

const subjects: Subject[] = [...codeHostAdapters(), fakeThirdAdapter].map((adapter) => ({
  name: adapter.name,
  adapter,
  script: SCRIPTS[adapter.name],
}));

const TOKEN = 'distinctive-secret-value-1234';
const REPO = { owner: 'acme', name: 'demo' };

function envOf({ adapter, script }: Subject, token: string) {
  return testEnv({ [adapter.baseKey]: script.base, [adapter.tokenKey]: token });
}

function appsOf(configured: boolean, connects = false): AppSource {
  return {
    credentials: () => (configured ? { clientId: 'client-id', clientSecret: 'client-secret' } : null),
    connects: () => connects,
  };
}

/** Serves the script of a host over `fetch`; the repository answers with `repo`. */
function serveScript(script: HostScript, repo: { status: number; push: boolean } = { status: 200, push: true }): void {
  global.fetch = jest.fn((url: string) => {
    const { pathname } = new URL(String(url));
    const { paths } = script;
    if (pathname === paths.token) {
      return Promise.resolve(
        fakeResponse(200, { access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 60 }),
      );
    }
    if (pathname === paths.user) {
      return Promise.resolve(fakeResponse(200, script.userBody()));
    }
    if (pathname === paths.groups) {
      return Promise.resolve(fakeResponse(200, script.groupsBody()));
    }
    if (pathname === paths.repo) {
      return Promise.resolve(fakeResponse(repo.status, repo.status < 400 ? script.repoBody(repo.push) : {}));
    }
    return Promise.resolve(fakeResponse(404, {}));
  }) as unknown as typeof fetch;
}

describe.each(subjects)('login provider contract: $name', (subject) => {
  const { adapter, script } = subject;
  const original = global.fetch;
  const login = (token = TOKEN, apps = appsOf(true), flow?: () => AppFlow) =>
    adapter.login(envOf(subject, token), new FakeClock(), apps, flow);
  const repos = [{ host: adapter.name, ...REPO }];

  beforeEach(() => {
    instantBackoff();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = original;
  });

  it('is configured only with credentials', () => {
    expect(login(TOKEN, appsOf(false)).configured()).toBe(false);
    expect(login(TOKEN, appsOf(true)).configured()).toBe(true);
  });

  it('carries the name, label, allow prefixes and client env keys of its adapter', () => {
    const provider = login();
    expect(provider.name).toBe(adapter.name);
    expect(provider.label).toBe(adapter.label);
    expect(provider.appLabel).toBe(adapter.appLabel);
    expect(provider.allowPrefixes).toEqual(adapter.allowPrefixes);
    expect(provider.clientEnvKeys).toEqual(adapter.clientEnvKeys);
  });

  it('builds an authorize url with the state and the PKCE challenge', () => {
    const verifier = 'a-long-random-verifier';
    const url = new URL(login().authorizeUrl('https://swarm.example/callback', 'state-1', verifier));
    expect(url.origin).toBe(script.base);
    expect(url.searchParams.get('state')).toBe('state-1');
    expect(url.searchParams.get('client_id')).toBe('client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://swarm.example/callback');
    expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('asks for no challenge when the verifier is empty', () => {
    const url = new URL(login().authorizeUrl('https://swarm.example/callback', 'state-1', ''));
    expect(url.searchParams.has('code_challenge')).toBe(false);
    expect(url.searchParams.has('code_challenge_method')).toBe(false);
  });

  it('identifies a person through its own HTTP and keeps no grant unless it connects', async () => {
    serveScript(script);
    const identity = await login().identify('code-1', 'https://swarm.example/callback', 'verifier');
    expect(identity).toEqual({ user: script.owner, avatarUrl: script.avatarUrl, groups: script.groups });
  });

  it('returns the grant when the provider connects', async () => {
    serveScript(script);
    const apps = appsOf(true, true);
    const identity = await login(TOKEN, apps).identify('code-1', 'https://swarm.example/callback', 'verifier');
    expect(identity.grant).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1', expiresIn: 60 });
  });

  it('names the owner of the server token, or none without a token', async () => {
    serveScript(script);
    expect(await login('').tokenOwner()).toBeNull();
    expect(await login().tokenOwner()).toBe(script.owner);
  });

  it('can push when the repository row allows it', async () => {
    serveScript(script, { status: 200, push: true });
    expect(await login().canPush('person-token', repos)).toBe(true);
  });

  it('cannot push when the repository row does not allow it', async () => {
    serveScript(script, { status: 200, push: false });
    expect(await login().canPush('person-token', repos)).toBe(false);
  });

  it.each([403, 404])('cannot push to a repository the host refuses with %s', async (status) => {
    serveScript(script, { status, push: false });
    expect(await login().canPush('person-token', repos)).toBe(false);
  });

  it('rejects when the host answers a client error other than a refusal', async () => {
    serveScript(script, { status: 400, push: false });
    await expect(login().canPush('person-token', repos)).rejects.toThrow(`${adapter.name} answered 400`);
  });

  it('misses every repository when no server token is set', async () => {
    serveScript(script);
    expect(await login('').serverTokenMisses(repos)).toEqual(repos);
  });

  it('misses the repositories the host answers 403 or 404 for, and keeps the ones it shows', async () => {
    serveScript(script, { status: 200, push: false });
    expect(await login().serverTokenMisses(repos)).toEqual([]);
    for (const status of [403, 404]) {
      serveScript(script, { status, push: false });
      expect(await login().serverTokenMisses(repos)).toEqual(repos);
    }
  });

  it('leaves out a repository whose read fails otherwise', async () => {
    serveScript(script, { status: 500, push: false });
    expect(await login().serverTokenMisses(repos)).toEqual([]);
    global.fetch = jest.fn(() => Promise.reject(new Error('down')));
    expect(await login().serverTokenMisses(repos)).toEqual([]);
  });

  it('has no app flow unless one is given, and exposes the one it is given', () => {
    expect(login().appFlow).toBeUndefined();
    const flow: AppFlow = {
      manifest: () => Promise.resolve({ action: 'https://host.example', manifest: {} }),
      installUrl: () => 'https://host.example/install',
      convert: () => Promise.resolve('slug'),
      installedAccount: () => Promise.resolve(null),
    };
    expect(login(TOKEN, appsOf(true), () => flow).appFlow).toBe(flow);
  });
});

describe.each(subjects)('secrets contract: $name', (subject) => {
  const { adapter } = subject;
  const line = `git push failed for ${TOKEN} on the remote`;
  let stop: (() => void) | undefined;

  afterEach(() => {
    stop?.();
    stop = undefined;
  });

  it('lists the configured token and nothing when none is set', () => {
    expect(adapter.create(envOf(subject, TOKEN), new FakeClock()).secrets()).toEqual([TOKEN]);
    expect(adapter.create(envOf(subject, ''), new FakeClock()).secrets()).toEqual([]);
  });

  it('keeps a token that no source lists in a log line', () => {
    expect(redact(line)).toBe(line);
  });

  it('masks the listed token in a log line once the host is a registered source', () => {
    const host = adapter.create(envOf(subject, TOKEN), new FakeClock());
    stop = registerSecretSource(() => host.secrets());
    expect(redact(line)).toBe('git push failed for *** on the remote');
    expect(redact(`Authorization: Bearer ${TOKEN}`)).not.toContain(TOKEN);
  });
});

describe('code host adapters in the contract', () => {
  it('lists the real hosts and not the fake third host, which has no index module', () => {
    const names = codeHostAdapters().map((adapter) => adapter.name);
    expect(names).toEqual(expect.arrayContaining(['github', 'gitlab']));
    expect(names).not.toContain(fakeThirdAdapter.name);
  });

  it('keeps the fake third host inside its own folder', () => {
    const source = readFileSync(`${__dirname}/fake-third/fake-third.spec-helpers.ts`, 'utf8');
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.filter((path) => /(^|\/)(github|gitlab)(\/|$)/.test(path))).toEqual([]);
  });
});
