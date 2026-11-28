import { testEnv } from '../../config/env.spec-helpers';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import { fakeThirdAdapter, fakeThirdScript } from './fake-third/fake-third.spec-helpers';
import { GitRuleRefused } from '../../core/git-rule-refused';
import { FetchFailed, isHostOutage, type HostUnavailable } from '../../core/swarmloop-error';
import type { CodeHost, MergeMethod, MergeRequestDraft } from './code-host';
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

/** The method and url of each request the fake host got since the last serve(). */
const requests: string[] = [];

function serve(handle: (method: string, url: string, body: Record<string, unknown>) => unknown): void {
  requests.length = 0;
  global.fetch = ((url: string, init?: { method?: string; body?: string }) => {
    requests.push(`${init?.method ?? 'GET'} ${String(url)}`);
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
    const sent = requests.length;
    await fake.host.setDraft(PROJECT, 1, true);
    expect(requests).toHaveLength(sent + 1);
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
    api: 'https://github.example/api/v3/repos/acme/demo',
    rejection: ['! [remote rejected] main -> main (protected branch hook declined)'],
  },
  {
    name: 'gitlab',
    make: gitlab,
    label: 'GitLab',
    api: 'https://gitlab.example/api/v4/projects/1',
    rejection: ['remote: GitLab: You are not allowed to push code to protected branches'],
  },
])('code host identity: $name', ({ name, make, label, api, rejection }) => {
  it('declares its name and label', () => {
    const { host } = make(false);
    expect(host.name).toBe(name);
    expect(host.label).toBe(label);
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

/** How one adapter words what the shared merge, author and title cases ask of it. */
interface Dialect {
  name: string;
  host: () => CodeHost;
  /** The repository answers that allow only `rebase` and `merge`, and only `squash`. */
  rebaseAndMerge: unknown;
  squashOnly: unknown;
  /** The body of a merge with no `how` and of a merge by `merge` with a title, for head `abc`. */
  plainMerge: unknown;
  titledMerge: unknown;
  /** An account with an id, an account with none, and the address and name the first gives. */
  account: unknown;
  accountWithoutId: unknown;
  noReply: string;
  /**
   * What the person's own connection says when the host gives no address: the paths that answer, the account the
   * token belongs to with an email, without one, and its email rows. Absent when the adapter has no such call.
   */
  connection?: {
    accountPath: string;
    self: unknown;
    selfWithoutEmail: unknown;
    otherSelf: unknown;
    emailsPath: string;
    emails: unknown;
    email: string;
    listed: string;
  };
  /** A refusal of the title by a rule, and a refusal that is not about the title. */
  titleRule: { status: number; body: unknown };
  otherRefusal: { status: number; body: unknown };
}

const DIALECTS: Dialect[] = [
  {
    name: 'github',
    host: () => githubService(),
    rebaseAndMerge: { allow_squash_merge: false, allow_rebase_merge: true, allow_merge_commit: true },
    squashOnly: { allow_squash_merge: true, allow_rebase_merge: false, allow_merge_commit: false },
    plainMerge: { merge_method: 'squash', sha: 'abc' },
    titledMerge: { merge_method: 'merge', commit_title: 'feat: ship', sha: 'abc' },
    account: { id: 7, login: 'robin', name: 'Robin Hood' },
    accountWithoutId: { login: 'robin', name: 'Robin Hood' },
    noReply: '7+robin@users.noreply.github.com',
    connection: {
      accountPath: '/user',
      self: { login: 'robin', email: 'robin@home.example' },
      selfWithoutEmail: { login: 'robin', email: null },
      otherSelf: { login: 'machine', email: 'machine@home.example' },
      emailsPath: '/user/emails',
      emails: [
        { email: 'old@home.example', primary: false, verified: true },
        { email: 'robin@work.example', primary: true, verified: true },
      ],
      email: 'robin@home.example',
      listed: 'robin@work.example',
    },
    titleRule: { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'Title rule: must match' }] } },
    otherRefusal: { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'base is gone' }] } },
  },
  {
    name: 'gitlab',
    host: () => gitlabService(),
    rebaseAndMerge: { merge_method: 'rebase_merge', squash_option: 'never' },
    squashOnly: { merge_method: 'merge', squash_option: 'always' },
    plainMerge: { squash: true, sha: 'abc' },
    titledMerge: { merge_commit_message: 'feat: ship', sha: 'abc' },
    account: [{ id: 7, username: 'robin', name: 'Robin Hood' }],
    accountWithoutId: [{ username: 'robin', name: 'Robin Hood' }],
    noReply: '7-robin@users.noreply.gitlab.example',
    connection: {
      accountPath: '/api/v4/user',
      self: { username: 'robin', commit_email: 'robin@home.example', email: 'other@home.example' },
      selfWithoutEmail: { username: 'robin', commit_email: null, email: null },
      otherSelf: { username: 'machine', commit_email: 'machine@home.example' },
      emailsPath: '/api/v4/user/emails',
      emails: [
        { email: 'new@home.example', confirmed_at: null },
        { email: 'robin@work.example', confirmed_at: '2026-01-01T00:00:00Z' },
      ],
      email: 'robin@home.example',
      listed: 'robin@work.example',
    },
    titleRule: { status: 422, body: { message: 'Title must match the pattern of the project' } },
    otherRefusal: { status: 422, body: { message: 'Target branch is gone' } },
  },
  {
    name: fakeThirdAdapter.name,
    host: () =>
      fakeThirdAdapter.create(
        testEnv({ [fakeThirdAdapter.baseKey]: FAKE_BASE, [fakeThirdAdapter.tokenKey]: 'frg_x' }),
        new FakeClock(),
      ),
    rebaseAndMerge: { merge_methods: ['rebase', 'merge'] },
    squashOnly: { merge_methods: ['squash'] },
    plainMerge: { how: 'squash', head: 'abc' },
    titledMerge: { how: 'merge', title: 'feat: ship', head: 'abc' },
    account: { name: 'Robin Hood', noreply: 'robin@noreply.forge.example' },
    accountWithoutId: { name: 'Robin Hood' },
    noReply: 'robin@noreply.forge.example',
    titleRule: { status: 422, body: { message: 'Title rule: must match' } },
    otherRefusal: { status: 422, body: { message: 'Target is gone' } },
  },
];

const FAKE_BASE = fakeThirdScript.base;

describe.each(DIALECTS)('merge methods, author and title rule: $name', (dialect) => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });

  /** Every call answers `status` and `body`; the requests are kept. */
  function answerWith(status: number, body: unknown): { method: string; url: string; body: unknown }[] {
    const seen: { method: string; url: string; body: unknown }[] = [];
    serve((method, url, sent) => {
      seen.push({ method, url, body: sent });
      return answer(status, body);
    });
    return seen;
  }

  it('maps the repository settings to methods in the order squash, rebase, merge', async () => {
    answerWith(200, dialect.rebaseAndMerge);
    expect((await dialect.host().readMergeMethods(PROJECT)).methods).toEqual(['rebase', 'merge']);
    answerWith(200, dialect.squashOnly);
    expect((await dialect.host().readMergeMethods(PROJECT)).methods).toEqual<MergeMethod[]>(['squash']);
  });

  it('squashes with the sha guard when no method is given', async () => {
    const seen = answerWith(200, { sha: 'merged-1', merge_commit_sha: 'merged-1' });
    await dialect.host().mergeMergeRequest(PROJECT, 1, 'abc');
    expect(seen.map((call) => call.body)).toEqual([dialect.plainMerge]);
  });

  it('merges by the method and the title it is given', async () => {
    const seen = answerWith(200, { sha: 'merged-1', merge_commit_sha: 'merged-1' });
    await dialect.host().mergeMergeRequest(PROJECT, 1, 'abc', { method: 'merge', title: 'feat: ship' });
    expect(seen.map((call) => call.body)).toEqual([dialect.titledMerge]);
  });

  it('gives the no-reply address and the name of an account', async () => {
    answerWith(200, dialect.account);
    const author = await dialect.host().readAuthor('robin');
    expect(author).toMatchObject({ name: 'Robin Hood', email: dialect.noReply });
  });

  it('gives no address when the host has none and the connection has no call for it', async () => {
    if (dialect.connection) return;
    answerWith(200, dialect.accountWithoutId);
    expect(await dialect.host().readAuthor('robin')).toMatchObject({ name: 'Robin Hood', email: null });
  });

  describe("the email of the person's own connection", () => {
    const { connection } = dialect;

    /** The account answers with no id; the paths of the connection answer as given, any other path is refused. */
    function connectionAnswers(answers: Record<string, unknown>): void {
      serve((_method, url) => {
        const path = new URL(url).pathname;
        const body = answers[path];
        return body === undefined
          ? answer(200, dialect.accountWithoutId)
          : answer(body === null ? 404 : 200, body ?? {});
      });
    }

    it('is the email the connection shows when the host has no no-reply address', async () => {
      if (!connection) return;
      connectionAnswers({ [connection.accountPath]: connection.self });
      expect(await dialect.host().readAuthor('robin')).toMatchObject({ name: 'Robin Hood', email: connection.email });
    });

    it('is the primary confirmed email when the account shows none', async () => {
      if (!connection) return;
      connectionAnswers({
        [connection.accountPath]: connection.selfWithoutEmail,
        [connection.emailsPath]: connection.emails,
      });
      expect(await dialect.host().readAuthor('robin')).toMatchObject({ email: connection.listed });
    });

    it('is none when the token belongs to another account or the host refuses the call', async () => {
      if (!connection) return;
      connectionAnswers({ [connection.accountPath]: connection.otherSelf });
      expect(await dialect.host().readAuthor('robin')).toMatchObject({ email: null });
      connectionAnswers({ [connection.accountPath]: null });
      expect(await dialect.host().readAuthor('robin')).toMatchObject({ email: null });
    });
  });

  it('refuses a title the repository rules refuse with the host message', async () => {
    answerWith(dialect.titleRule.status, dialect.titleRule.body);
    const refused = await dialect
      .host()
      .openMergeRequest(request(false))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(GitRuleRefused);
    expect(refused).toMatchObject({ name: 'Ship the field', kind: 'title' });
    expect((refused as GitRuleRefused).hostMessage).toMatch(/title/i);
  });

  it('keeps another refusal of an open a FetchFailed', async () => {
    answerWith(dialect.otherRefusal.status, dialect.otherRefusal.body);
    const refused = await dialect
      .host()
      .openMergeRequest(request(false))
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(FetchFailed);
    expect(refused).not.toBeInstanceOf(GitRuleRefused);
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

describe.each([
  { name: 'github', host: githubService, token: 'GITHUB_TOKEN', access: 'Actions, Checks and Commit statuses' },
  { name: 'gitlab', host: gitlabService, token: 'GITLAB_TOKEN', access: 'read_api scope' },
])('the pipelines read of $name', ({ host, token, access }) => {
  /** The host answers every call with this status, from the url it was asked. */
  function answerAll(status: number): void {
    serve((_method, url) => ({ ...(answer(status, {}) as object), url }));
  }

  const reads = {
    readBranchPipeline: (service: CodeHost) => service.readBranchPipeline({ project: PROJECT, ref: 'main' }),
    readBranchHasPipeline: (service: CodeHost) => service.readBranchHasPipeline({ project: PROJECT, ref: 'main' }),
  };

  describe.each(Object.entries(reads))('%s', (_read, call) => {
    it.each([403, 404])('waits for the access to the CI on a %s, never a rejected token', async (status) => {
      answerAll(status);
      const refused = await call(host()).catch((error: unknown) => error);
      expect(isHostOutage(refused)).toBe(true);
      const outage = refused as HostUnavailable;
      expect(outage.detail).toContain(PROJECT);
      expect(outage.detail).toContain(access);
      expect(outage.detail).toContain(`HTTP ${status}`);
      expect(outage.message).not.toContain('was rejected');
      expect(Date.parse(outage.retryAt)).not.toBeNaN();
    });

    it.each([
      ['a spent limit', { 'x-ratelimit-remaining': '0' }],
      ['a secondary limit with a retry-after', { 'retry-after': '60', 'x-ratelimit-remaining': '12' }],
    ])('does not read a 403 of %s as a refusal', async (_name, limit: Record<string, string>) => {
      serve((_method, url) => ({
        ...(answer(403, {}) as object),
        url,
        headers: { get: (name: string) => limit[name] ?? null },
      }));
      const failed = await call(host()).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(FetchFailed);
      expect(isHostOutage(failed)).toBe(false);
    });

    it('still rejects a 401 as a rejected token', async () => {
      answerAll(401);
      await expect(call(host())).rejects.toThrow(`${token} was rejected`);
    });
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
