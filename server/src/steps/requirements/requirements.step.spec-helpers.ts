import 'reflect-metadata';

import type { TestingModule } from '@nestjs/testing';

import { Test } from '@nestjs/testing';

import { getRepositoryToken } from '@nestjs/typeorm';

import { createServer, Server } from 'http';

import type { ServerResponse } from 'http';

import { writeFile } from 'fs/promises';

import { join } from 'path';

import type { AddressInfo } from 'net';

import type { Repository } from 'typeorm';

import { SwarmloopConfigModule } from '../../config/config.module';

import { DocumentEntity, RunEntity } from '../../history/entities';

import type { AgentRunResult } from '../../agent/agent-runner';

import { AGENT_RUNNER } from '../../agent/agent-runner';

import { PipelineModule } from '../../pipeline/pipeline.module';

import { SandboxService } from '../../sandbox/sandbox.service';

import { PASTE_READER } from '../../integrations/linked-pages/paste-page.reader';

export const TOKEN = 'super-secret-token';

export async function requirementsBody(app: TestingModule, key?: string): Promise<string> {
  const documents = await app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity)).find();
  const runs = key ? await app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity)).find() : [];
  const runId = key ? runs.find((run) => run.key === key)?.id : undefined;
  const row = documents.find(
    (document) => document.kind === 'requirements' && (runId === undefined || document.runId === runId),
  );
  if (!row) {
    throw new Error('requirements record is missing');
  }
  return row.body;
}

export async function boot(
  root: string,
  base: string,
  via: 'direct' | 'agent',
  paste: jest.Mock,
  agent: jest.Mock,
  write = true,
  sandbox?: { assertReady: jest.Mock },
): Promise<TestingModule> {
  if (write) {
    await writeEnv(root, base, via);
  }
  const builder = Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(PASTE_READER)
    .useValue({ read: paste })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: agent });
  if (sandbox) {
    builder.overrideProvider(SandboxService).useValue(sandbox);
  }
  return builder.compile();
}

export async function writeEnv(
  root: string,
  base: string,
  via: string,
  extra: Record<string, string> = {},
): Promise<void> {
  const values: Record<string, string> = {
    RUNTIME: 'cursor',
    REQUIREMENTS_VIA: via,
    ISSUE_TRACKER: 'jira',
    JIRA_BASE_URL: base,
    JIRA_EMAIL: 'dev@example.com',
    JIRA_API_TOKEN: TOKEN,
    GITLAB_BASE_URL: '',
    GITLAB_TOKEN: '',
    GITHUB_BASE_URL: '',
    GITHUB_TOKEN: '',
    CURSOR_API_KEY: '',
    ANTHROPIC_API_KEY: '',
    MAX_AGENT_CALLS: '20',
    MAX_RETURNS: '3',
    MAX_LAUNCHES: '3',
    MAX_RUN_USD: '25',
    IDLE_TIMEOUT_MS: '900000',
    TICK_MS: '15000',
    REQUIREMENTS_TIMEOUT_MS: '600000',
    RESEARCH_TIMEOUT_MS: '900000',
    PLAN_TIMEOUT_MS: '1200000',
    IMPLEMENT_TIMEOUT_MS: '1800000',
    CODE_REVIEW_TIMEOUT_MS: '900000',
    MERGE_REQUEST_TIMEOUT_MS: '600000',
    PIPELINE_TIMEOUT_MS: '1800000',
    PIPELINE_START_TIMEOUT_MS: '180000',
    MODEL_PLAN: 'opus-5.5-extra-high',
    MODEL_IMPLEMENT: 'grok-4.7',
    SWARMLOOP_API_PORT: '3920',
    SWARMLOOP_API_HOST: '127.0.0.1',
    SWARMLOOP_ROOT: root,
    ...extra,
  };
  const body = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  await writeFile(join(root, '.env'), `${body}\n`);
}

export function emptyAgent(): AgentRunResult {
  const now = new Date().toISOString();
  return {
    responseText: '',
    chatId: null,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    killReason: null,
    exitCode: 0,
    resumed: false,
    calls: 1,
    samples: [],
    durationMs: 1,
    startedAt: now,
    finishedAt: now,
  };
}

export async function listen(
  issueStatus = 200,
  issueFailures = 0,
  hooks: { issueHits?: Record<string, number>; failOnce?: string; linkIssue?: boolean } = {},
): Promise<{ base: string; close: () => Promise<void> }> {
  let remainingFailures = issueFailures;
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const issueKey = url.pathname.match(/^\/rest\/api\/3\/issue\/([A-Z][A-Z0-9]+-\d+)$/)?.[1];
    if (issueKey && hooks.issueHits) {
      hooks.issueHits[issueKey] = (hooks.issueHits[issueKey] ?? 0) + 1;
    }
    if (issueKey && hooks.failOnce === issueKey) {
      hooks.failOnce = '';
      res.writeHead(500);
      res.end('nope');
      return;
    }
    if (remainingFailures > 0 && url.pathname.startsWith('/rest/api/3/issue/')) {
      remainingFailures -= 1;
      res.writeHead(500);
      res.end('nope');
      return;
    }
    if (issueStatus !== 200 && url.pathname.startsWith('/rest/api/3/issue')) {
      res.writeHead(issueStatus);
      res.end('nope');
      return;
    }
    if (url.pathname === '/rest/api/3/project/PROJ') {
      send(res, { key: 'PROJ' });
      return;
    }
    if (url.pathname === '/rest/api/3/field') {
      send(res, [{ id: 'customfield_10037', name: 'Acceptance criteria' }]);
      return;
    }
    if (url.pathname === '/rest/api/3/issue/PROJ-1') {
      send(res, {
        key: 'PROJ-1',
        fields: {
          summary: 'Big epic',
          issuetype: { name: 'Epic' },
          description: doc([text('See '), link('the page', `${origin(req)}/wiki/spaces/ENG/pages/42/Title`)]),
        },
      });
      return;
    }
    if (url.pathname === '/rest/api/3/issue/PROJ-2') {
      const base = origin(req);
      send(res, {
        key: 'PROJ-2',
        fields: {
          summary: 'Ship the thing',
          issuetype: { name: 'Story' },
          parent: { key: 'PROJ-1' },
          customfield_10037: doc([text('Must ship')]),
          description: doc([
            text('Do the work '),
            link('spec', `${base}/spec.txt`),
            text(' '),
            link('blob', `${base}/blob.bin`),
            ...(hooks.linkIssue
              ? [
                  text(' '),
                  link('related', `${base}/browse/PROJ-9`),
                  text(' '),
                  link('board', `${base}/jira/software/projects/PROJ/boards/1?selectedIssue=PROJ-9`),
                ]
              : []),
          ]),
          attachment: [{ filename: 'note.txt', content: `${base}/attachment/9` }],
          ...(hooks.linkIssue
            ? { issuelinks: [{ inwardIssue: { key: 'PROJ-404' } }, { inwardIssue: { key: 'PROJ-7' } }] }
            : {}),
        },
      });
      return;
    }
    if (url.pathname === '/rest/api/3/issue/PROJ-1/comment') {
      send(res, {
        startAt: 0,
        maxResults: 100,
        total: 1,
        comments: [{ author: { displayName: 'Pat' }, created: '2026-01-01', body: doc([text('Epic note')]) }],
      });
      return;
    }
    if (url.pathname === '/rest/api/3/issue/PROJ-9') {
      send(res, {
        key: 'PROJ-9',
        fields: {
          summary: 'Linked story',
          status: { name: 'Gotowe', statusCategory: { key: 'done' } },
          issuetype: { name: 'Story' },
          description: doc([text('Linked body')]),
          customfield_10037: doc([text('Linked must')]),
          subtasks: [{ key: 'PROJ-6' }],
        },
      });
      return;
    }
    if (url.pathname === '/rest/api/3/issue/PROJ-9/comment') {
      send(res, {
        startAt: 0,
        maxResults: 100,
        total: 1,
        comments: [{ author: { displayName: 'Ada' }, created: '2026-02-02', body: doc([text('Linked note')]) }],
      });
      return;
    }
    if (url.pathname === '/rest/api/3/issue/PROJ-7') {
      send(res, {
        key: 'PROJ-7',
        fields: { summary: 'Blocker', issuetype: { name: 'Story' }, description: doc([text('Blocks this')]) },
      });
      return;
    }
    if (url.pathname === '/rest/api/3/issue/PROJ-6') {
      send(res, {
        key: 'PROJ-6',
        fields: {
          summary: 'Child change',
          issuetype: { name: 'Sub-task' },
          description: doc([text('Schema lives here')]),
        },
      });
      return;
    }
    if (url.pathname === '/rest/api/3/issue/PROJ-6/comment') {
      send(res, {
        startAt: 0,
        maxResults: 100,
        total: 1,
        comments: [{ author: { displayName: 'Pawel' }, created: '2026-10-16', body: doc([text('Scope moved here')]) }],
      });
      return;
    }
    if (url.pathname === '/rest/api/3/issue/PROJ-8') {
      send(res, {
        key: 'PROJ-8',
        fields: { summary: 'Second', issuetype: { name: 'Story' }, description: doc([text('Other')]) },
      });
      return;
    }
    if (url.pathname === '/rest/api/3/issue/PROJ-8/comment') {
      send(res, { startAt: 0, maxResults: 100, total: 0, comments: [] });
      return;
    }
    if (url.pathname === '/rest/api/3/issue/PROJ-2/comment') {
      const start = Number(url.searchParams.get('startAt') ?? '0');
      const comments = [
        { author: { displayName: 'Ann' }, created: '2026-01-01', body: doc([text('First note')]) },
        { author: { displayName: 'Bo' }, created: '2026-01-02', body: doc([text('Second note')]) },
      ];
      send(res, { startAt: start, maxResults: 1, total: 2, comments: comments.slice(start, start + 1) });
      return;
    }
    if (url.pathname === '/wiki/rest/api/content/42') {
      send(res, { id: '42', title: 'Design', body: { storage: { value: '<p>Page</p>' } } });
      return;
    }
    if (url.pathname === '/attachment/9') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('file-body');
      return;
    }
    if (url.pathname === '/spec.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('spec-body');
      return;
    }
    if (url.pathname === '/blob.bin') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([0, 1, 2]));
      return;
    }
    if (/^\/rest\/api\/3\/issue\/[A-Z][A-Z0-9]+-\d+\/comment$/.test(url.pathname)) {
      send(res, { startAt: 0, maxResults: 100, total: 0, comments: [] });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

export function origin(req: { headers: { host?: string } }): string {
  return `http://${req.headers.host}`;
}

export function send(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function doc(content: unknown[]): unknown {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content }] };
}

export function text(value: string): unknown {
  return { type: 'text', text: value };
}

export function link(value: string, href: string): unknown {
  return { type: 'text', text: value, marks: [{ type: 'link', attrs: { href } }] };
}

void Server;
