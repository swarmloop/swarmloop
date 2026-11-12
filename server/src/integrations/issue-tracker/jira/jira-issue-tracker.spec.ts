import { createServer } from 'http';
import type { AddressInfo } from 'net';
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
