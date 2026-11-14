import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { startCatalog } from '../../atlassian.spec-helpers';
import type { CatalogApp } from '../../atlassian.spec-helpers';
import { startFakeAtlassian } from '../../../testing/fake-atlassian';
import type { FakeAtlassian } from '../../../testing/fake-atlassian';
import type { PastePageReader } from '../../linked-pages/paste-page.reader';
import { LinkedPagesService as Pages } from '../../linked-pages/linked-pages';
import { AppConfig } from '../../../config/env';
import { testEnv } from '../../../config/env.spec-helpers';
import { SystemClock } from '../../../core/clock';
import { HostUnavailable } from '../../../core/swarmloop-error';
import { instantBackoff } from '../../instant-backoff.spec-helpers';
import type { SwarmloopEnv } from '../../../config/env';
import type { LinkedPagesService } from '../../linked-pages/linked-pages';
import { JiraIssueTracker } from './jira-issue-tracker';

const PLAIN = 'Use UTF-8, SHA-256, ISO-8601, GPT-4 and CVE-2026-1234 as text.';

/** A fake Jira that knows the project PROJ and counts the project lookups. */
async function fakeJira(): Promise<{ base: string; asked: string[]; close: () => Promise<void> }> {
  const asked: string[] = [];
  const server = createServer((req, res) => {
    const project = new URL(req.url ?? '/', 'http://127.0.0.1').pathname.match(/^\/rest\/api\/3\/project\/(.+)$/)?.[1];
    if (project) {
      asked.push(project);
    }
    res.writeHead(project === 'PROJ' ? 200 : 404, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    asked,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function trackerWith(env: Partial<SwarmloopEnv>): JiraIssueTracker {
  return new JiraIssueTracker(new AppConfig(testEnv(env)), {} as LinkedPagesService, new SystemClock());
}

const configured = (base: string, projects = ''): Partial<SwarmloopEnv> => ({
  JIRA_BASE_URL: base,
  JIRA_EMAIL: 'dev@example.com',
  JIRA_API_TOKEN: 'token',
  JIRA_PROJECTS: projects,
});

describe('JiraIssueTracker.ticketKeys', () => {
  it('finds no keys in plain text without Jira', async () => {
    expect(await trackerWith({}).ticketKeys(`${PLAIN} PROJ-12`)).toEqual([]);
  });

  it('finds no keys in plain text when JIRA_PROJECTS is set', async () => {
    const jira = await fakeJira();
    try {
      expect(await trackerWith(configured(jira.base, 'PROJ')).ticketKeys(PLAIN)).toEqual([]);
      expect(jira.asked).toEqual([]);
    } finally {
      await jira.close();
    }
  });

  it('returns the keys of the listed projects', async () => {
    const jira = await fakeJira();
    try {
      const keys = await trackerWith(configured(jira.base, 'PROJ')).ticketKeys(`${PLAIN} Do PROJ-12 and PROJ-12.`);
      expect(keys).toEqual(['PROJ-12']);
    } finally {
      await jira.close();
    }
  });

  it('asks once for a project that does not exist, then ignores it', async () => {
    const jira = await fakeJira();
    try {
      const tracker = trackerWith(configured(jira.base));
      const text = `${PLAIN} Do PROJ-12.`;
      expect(await tracker.ticketKeys(text)).toEqual(['PROJ-12']);
      expect(await tracker.ticketKeys(text)).toEqual(['PROJ-12']);
      expect([...jira.asked].sort()).toEqual(['CVE', 'GPT', 'ISO', 'PROJ', 'SHA', 'UTF']);
    } finally {
      await jira.close();
    }
  });
});

describe('JiraIssueTracker while Jira is down', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('lets a project lookup that never answers surface as HostUnavailable, and asks again once Jira is back', async () => {
    instantBackoff();
    let up = false;
    const server = createServer((_req, res) => {
      res.writeHead(up ? 200 : 503);
      res.end('{}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const tracker = trackerWith(configured(base));
      await expect(tracker.ticketKeys('Do PROJ-12')).rejects.toBeInstanceOf(HostUnavailable);
      up = true;
      expect(await tracker.ticketKeys('Do PROJ-12')).toEqual(['PROJ-12']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('JiraIssueTracker for a person', () => {
  const ANN = { email: 'ann@example.com', token: 'ann-token', name: 'Ann' };
  const SERVER = { email: 'server@example.com', token: 'server-token', name: 'Server' };
  const basic = (account: { email: string; token: string }) =>
    `Basic ${Buffer.from(`${account.email}:${account.token}`).toString('base64')}`;
  let jira: FakeAtlassian;
  let wiki: FakeAtlassian;
  let app: CatalogApp;
  const pastes = {
    savedPastes: () => Promise.resolve({}),
    read: () => Promise.resolve('pasted'),
    rememberPaste: () => Promise.resolve(),
  } as unknown as PastePageReader;

  const trackerFor = (env: Partial<SwarmloopEnv>): JiraIssueTracker => {
    const config = new AppConfig(testEnv(env));
    const clock = new SystemClock();
    return new JiraIssueTracker(config, new Pages(pastes, app.personal), clock, app.personal);
  };
  const form = (site: FakeAtlassian, account: { email: string; token: string }) => ({
    JIRA_BASE_URL: site.base,
    JIRA_EMAIL: account.email,
    JIRA_API_TOKEN: account.token,
  });

  beforeEach(async () => {
    wiki = await startFakeAtlassian([ANN], { pages: { '77': 'Design' } });
    jira = await startFakeAtlassian([ANN, SERVER], {
      issues: { 'PROJ-1': { summary: 'Ship it', pageUrl: `${wiki.base}/wiki/spaces/ENG/pages/77/Design` } },
      pages: { '77': 'Design' },
    });
    app = await startCatalog();
  });
  afterEach(async () => {
    await app.close();
    await jira.close();
    await wiki.close();
  });

  it('fetches with the Basic auth of the person who has a Jira connection', async () => {
    await app.catalog.save('jira', 'ann', form(jira, ANN));
    jira.requests.length = 0;
    const tracker = trackerFor(configured(jira.base));
    const { bundle } = await tracker.fetch('PROJ-1', '/tmp/run-a', 'ann');
    expect(bundle.summary).toBe('Ship it');
    expect(new Set(jira.authorizations('/rest/api/3/issue'))).toEqual(new Set([basic(ANN)]));
  });

  it('reads the pages with the Confluence connection of the person', async () => {
    await app.catalog.save('jira', 'ann', form(jira, ANN));
    await app.catalog.save('confluence', 'ann', form(wiki, ANN));
    wiki.requests.length = 0;
    const { bundle } = await trackerFor({}).fetch('PROJ-1', '/tmp/run-a', 'ann');
    expect(bundle.confluence.map((page) => page.title)).toEqual(['Design']);
    expect(wiki.authorizations('/wiki/rest/api/content')).toEqual([basic(ANN)]);
  });

  it('reads the pages with the credential the Jira fetch used when there is no Confluence connection', async () => {
    const own = await startFakeAtlassian([ANN], {
      issues: { 'PROJ-2': { summary: 'Pages', pageUrl: '{base}/wiki/spaces/ENG/pages/77/Design' } },
      pages: { '77': 'Design' },
    });
    try {
      await app.catalog.save('jira', 'bob', form(own, ANN));
      const { bundle } = await trackerFor({}).fetch('PROJ-2', '/tmp/run-b', 'bob');
      expect(bundle.confluence.map((page) => page.title)).toEqual(['Design']);
      expect(own.authorizations('/wiki/rest/api/content')).toEqual([basic(ANN)]);
    } finally {
      await own.close();
    }
  });

  it('uses env for a run with no connection, as before', async () => {
    const tracker = trackerFor({ JIRA_BASE_URL: jira.base, JIRA_EMAIL: SERVER.email, JIRA_API_TOKEN: SERVER.token });
    await tracker.fetch('PROJ-1', '/tmp/run-c', null);
    expect(new Set(jira.authorizations('/rest/api/3/issue'))).toEqual(new Set([basic(SERVER)]));
  });

  it('keeps the env text of the missing-credential error and adds the hint', async () => {
    await expect(trackerFor({}).fetch('PROJ-1', '/tmp/run-d', 'ann')).rejects.toThrow(
      'this run id is a Jira key, but JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are not set. Connect Jira at /connections#jira',
    );
  });

  it('asks each site for its own projects when two people have different Jira sites', async () => {
    const other = await startFakeAtlassian([ANN]);
    try {
      await app.catalog.save('jira', 'ann', form(jira, ANN));
      await app.catalog.save('jira', 'bob', form(other, ANN));
      const tracker = trackerFor({});
      expect(await tracker.ticketKeys('Do PROJ-12', 'ann')).toEqual(['PROJ-12']);
      expect(await tracker.ticketKeys('Do PROJ-12', 'bob')).toEqual(['PROJ-12']);
      expect(jira.authorizations('/rest/api/3/project/PROJ')).toHaveLength(1);
      expect(other.authorizations('/rest/api/3/project/PROJ')).toHaveLength(1);
    } finally {
      await other.close();
    }
  });
});
