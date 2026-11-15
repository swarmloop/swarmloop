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
import type { CodeHost, MergeRequestDraft } from './code-host';
import { GithubCodeHost } from './github/github-code-host';
import { GitlabCodeHost } from './gitlab/gitlab-code-host';
import { instantBackoff } from '../instant-backoff.spec-helpers';
import { mockFetch as githubFetch, service as githubService } from './github/github-code-host.spec-helpers';
import { mockFetch as gitlabFetch, service as gitlabService } from './gitlab/gitlab-code-host.spec-helpers';

/** The check runs and commit statuses of a commit that has none. */
const QUIET = [{ check_runs: [] }, { statuses: [] }];

const PROJECT = 'acme/demo';
const SOURCE = 'feature/PROJ-1-ship';

/** One merge request of a fake host: its draft state as the host keeps it. */
interface Row {
  draft: boolean;
  title: string;
  body: string;
}

/** A fake code host behind `fetch`: it keeps one merge request and answers the calls an adapter makes. */
interface FakeHost {
  host: CodeHost;
  /** The merge request the fake keeps, or null before one was opened. */
  row(): Row | null;
  /** The body of every PATCH or PUT the adapter sent. */
  updates: string[];
}

type Factory = (refuseDrafts: boolean) => FakeHost;

function answer(status: number, payload: unknown): unknown {
  return {
    status,
    ok: status >= 200 && status < 300,
    url: 'https://fake.example',
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    arrayBuffer: () => Promise.resolve(Buffer.from(JSON.stringify(payload))),
  };
}

/** A string field of a request body, or the current value when the call did not send it. */
function text(value: unknown, current: string): string {
  return typeof value === 'string' ? value : current;
}

function serve(handle: (method: string, url: string, body: Record<string, unknown>) => unknown): void {
  global.fetch = jest.fn((url: string, init?: { method?: string; body?: string }) => {
    const reply = handle(init?.method ?? 'GET', String(url), init?.body ? JSON.parse(init.body) : {});
    return Promise.resolve(reply);
  }) as unknown as typeof fetch;
}

const github: Factory = (refuseDrafts) => {
  let row: (Row & { number: number }) | null = null;
  const updates: string[] = [];
  const view = (): unknown => ({
    number: 1,
    node_id: 'PR_1',
    html_url: 'https://github.com/acme/demo/pull/1',
    head: { ref: SOURCE },
    state: 'open',
    draft: row?.draft,
    body: row?.body,
  });
  serve((method, url, body) => {
    if (url.endsWith('/graphql')) {
      row!.draft = String(body.query).includes('convertPullRequestToDraft');
      return answer(200, { data: {} });
    }
    if (method === 'POST') {
      if (row || (refuseDrafts && body.draft === true)) {
        return answer(422, {
          message: row ? 'A pull request already exists' : 'Draft pull requests are not supported',
        });
      }
      row = { number: 1, draft: body.draft === true, title: String(body.title), body: String(body.body) };
      return answer(201, view());
    }
    if (method === 'PATCH') {
      updates.push(JSON.stringify(body));
      row!.body = text(body.body, row!.body);
      return answer(200, view());
    }
    return answer(200, url.includes('/pulls?') ? (row ? [view()] : []) : view());
  });
  const host = new GithubCodeHost(
    testEnv({ GITHUB_BASE_URL: 'https://github.com', GITHUB_TOKEN: 'token' }),
    new FakeClock(),
  );
  return { host, row: () => row, updates };
};

const gitlab: Factory = (refuseDrafts) => {
  let row: Row | null = null;
  const updates: string[] = [];
  const view = (): unknown => ({
    iid: 1,
    web_url: 'https://gitlab.example/acme/demo/-/merge_requests/1',
    source_branch: SOURCE,
    state: 'opened',
    title: row?.title,
    description: row?.body,
  });
  serve((method, url, body) => {
    if (method === 'POST') {
      if (row) {
        return answer(409, { message: 'Another open merge request already exists' });
      }
      const title = String(body.title);
      // A host that ignores the marker keeps the title as it came, and the request is not a draft.
      row = { title, body: String(body.description), draft: !refuseDrafts && title.startsWith('Draft: ') };
      if (refuseDrafts) {
        row.title = title.replace(/^Draft: /, '');
      }
      return answer(201, view());
    }
    if (method === 'PUT') {
      updates.push(JSON.stringify(body));
      row!.title = text(body.title, row!.title);
      row!.body = text(body.description, row!.body);
      row!.draft = row!.title.startsWith('Draft: ');
      return answer(200, view());
    }
    return answer(200, url.includes('/merge_requests?') ? (row ? [view()] : []) : view());
  });
  const host = new GitlabCodeHost(
    testEnv({ GITLAB_BASE_URL: 'https://gitlab.example', GITLAB_TOKEN: 'token' }),
    new FakeClock(),
  );
  return { host, row: () => row, updates };
};

const request = (draft: boolean): MergeRequestDraft => ({
  project: PROJECT,
  source: SOURCE,
  target: 'main',
  title: 'Ship the field',
  summary: 'Ships the field.',
  draft,
});

describe.each([
  ['github', github],
  ['gitlab', gitlab],
] as const)('code host conformance: %s', (_name, make) => {
  const original = global.fetch;

  afterEach(() => {
    global.fetch = original;
  });

  it('opens a merge request as a draft', async () => {
    const fake = make(false);
    const opened = await fake.host.openMergeRequest(request(true));
    expect(opened.record.draft).toBe(true);
    expect(opened.draftsUnavailable).toBe(false);
    expect(fake.row()?.draft).toBe(true);
    expect((await fake.host.readMergeRequest(PROJECT, 1)).draft).toBe(true);
    expect((await fake.host.findMergeRequest({ project: PROJECT, source: SOURCE })).record?.draft).toBe(true);
  });

  it('marks a draft ready and turns it back into a draft', async () => {
    const fake = make(false);
    await fake.host.openMergeRequest(request(true));
    await fake.host.setDraft(PROJECT, 1, false);
    expect(fake.row()?.draft).toBe(false);
    expect((await fake.host.readMergeRequest(PROJECT, 1)).draft).toBe(false);
    await fake.host.setDraft(PROJECT, 1, true);
    expect(fake.row()?.draft).toBe(true);
    expect(fake.row()?.title.replace(/^Draft: /, '')).toBe('Ship the field');
  });

  it('leaves a request that is already in the asked state alone', async () => {
    const fake = make(false);
    await fake.host.openMergeRequest(request(true));
    const sent = jest.mocked(global.fetch).mock.calls.length;
    await fake.host.setDraft(PROJECT, 1, true);
    expect(jest.mocked(global.fetch).mock.calls.length).toBe(sent + 1);
  });

  it('opens a normal merge request when the host refuses drafts', async () => {
    const fake = make(true);
    const opened = await fake.host.openMergeRequest(request(true));
    expect(opened.draftsUnavailable).toBe(true);
    expect(opened.record.draft).toBe(false);
    expect(fake.row()?.draft).toBe(false);
  });

  it('does not report a refusal when a normal merge request was asked for', async () => {
    const fake = make(true);
    const opened = await fake.host.openMergeRequest(request(false));
    expect(opened.draftsUnavailable).toBe(false);
    expect(opened.record.draft).toBe(false);
  });

  it('updates the open merge request when create conflicts and keeps its draft state', async () => {
    const fake = make(false);
    await fake.host.openMergeRequest(request(true));
    const again = await fake.host.openMergeRequest({ ...request(true), summary: 'Updated.' });
    expect(again.record.iid).toBe(1);
    expect(again.record.summary).toBe('Updated.');
    expect(fake.row()?.body).toBe('Updated.');
    expect(fake.row()?.draft).toBe(true);
    expect(fake.updates).toHaveLength(1);
    expect(fake.updates[0]).not.toContain('draft');
    expect(fake.updates[0]).not.toContain('title');
  });
});

describe.each([
  {
    name: 'github',
    make: github,
    label: 'GitHub',
    ciFiles: ['.github/workflows/*.yml', '.github/workflows/*.yaml'],
    api: 'https://github.example/api/v3/repos/acme/demo',
    rejection: ['! [remote rejected] main -> main (protected branch hook declined)'],
  },
  {
    name: 'gitlab',
    make: gitlab,
    label: 'GitLab',
    ciFiles: ['.gitlab-ci.yml'],
    api: 'https://gitlab.example/api/v4/projects/1',
    rejection: ['remote: GitLab: You are not allowed to push code to protected branches'],
  },
])('code host identity: $name', ({ name, make, label, ciFiles, api, rejection }) => {
  it('declares its name, label and CI files', () => {
    const { host } = make(false);
    expect(host.name).toBe(name);
    expect(host.label).toBe(label);
    expect(host.ciFiles).toEqual(ciFiles);
  });

  it('labels a call of its API with its name and leaves a redirect to another host unlabeled', () => {
    const { host } = make(false);
    expect(host.classifyCall(api)).toBe(name);
    expect(host.classifyCall('https://objects.example/log.zip')).toBeNull();
  });

  it('picks the line that explains a refused push', () => {
    const { host } = make(false);
    expect(host.pushRejection(['fatal: unable to access', ...rejection])).toBe(rejection[0]);
    expect(host.pushRejection(['fatal: unable to access'])).toBeUndefined();
  });
});

describe('github host', () => {
  const original = global.fetch;

  beforeEach(() => {
    instantBackoff();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = original;
  });

  it('still lists failed jobs when the running list is skipped', async () => {
    const seen = githubFetch([
      {
        workflow_runs: [
          {
            id: 9,
            head_sha: 'abc',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.com/acme/demo/actions/runs/9',
          },
        ],
      },
      { jobs: [{ id: 4, name: 'test', conclusion: 'failure' }] },
      ...QUIET,
    ]);
    const pipeline = await githubService().readBranchPipeline(
      { project: 'acme/demo', ref: 'feature/PROJ-1-ship', sha: 'abc' },
      false,
    );
    expect(pipeline.snapshot?.jobs).toEqual([
      { id: 4, name: 'test', stage: '', status: 'failed', allowFailure: false },
    ]);
    expect(seen[1]?.url).toContain('/actions/runs/9/jobs');
  });
});

describe('gitlab host', () => {
  const original = global.fetch;

  beforeEach(() => {
    instantBackoff();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    global.fetch = original;
  });

  it('still lists failed jobs when the running list is skipped', async () => {
    const seen = gitlabFetch([
      [{ id: 9, status: 'failed' }],
      { id: 9, status: 'failed', web_url: 'https://gitlab.example/group/demo/-/pipelines/9' },
      [{ id: 7, name: 'unit', stage: 'test', status: 'failed', allow_failure: false }],
    ]);
    const result = await gitlabService().readBranchPipeline({ project: 'group/demo', ref: 'feature/PROJ-1' }, false);
    expect(result.snapshot?.jobs.map((job) => job.name)).toEqual(['unit']);
    expect(seen[2]?.url).toContain('/pipelines/9/jobs');
  });
});

describe('code host interface', () => {
  it('requires diagnoseMissingPipeline of an adapter', () => {
    const withoutDiagnosis = {} as Omit<GithubCodeHost, 'diagnoseMissingPipeline'>;
    // @ts-expect-error an adapter without diagnoseMissingPipeline is not a CodeHost
    const host: CodeHost = withoutDiagnosis;
    expect(host).toBeDefined();
  });

  it('requires setDraft of an adapter', () => {
    const withoutDraft = {} as Omit<GithubCodeHost, 'setDraft'>;
    // @ts-expect-error an adapter without setDraft is not a CodeHost
    const host: CodeHost = withoutDraft;
    expect(host).toBeDefined();
  });
});

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
