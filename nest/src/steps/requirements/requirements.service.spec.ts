import 'reflect-metadata';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { createServer, Server } from 'http';
import { mkdtemp, readFile, writeFile } from 'fs/promises';
import { existsSync, mkdirSync, realpathSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AddressInfo } from 'net';
import { Repository } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { AgentExchangeEntity, DocumentEntity, HttpCallEntity, RunEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER, AgentRunResult } from '../../limits/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../swarmloop-error';
import { IssueTracker } from '../../providers/contracts';
import { PASTE_READER } from '../../integrations/linked-pages/paste-page.reader';
import { ISSUE_TRACKER } from '../../providers/tokens';
import { requirementsBrief } from '../requirements-brief';

const TOKEN = 'super-secret-token';

describe('requirements step', () => {
  it('stores the epic, comments, and a paste, then writes requirements without a model', async () => {
    const server = await listen();
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-req-'));
    const paste = jest.fn().mockResolvedValue('pasted-body');
    const agent = jest.fn();
    const app = await boot(root, server.base, 'direct', paste, agent);
    const tracker = app.get<IssueTracker>(ISSUE_TRACKER);
    const runDir = join(root, 'runs', 'PROJ-2');
    try {
      await tracker.fetch('PROJ-2', runDir);
      await tracker.fetch('PROJ-2', runDir);
      expect(paste).toHaveBeenCalledTimes(1);
      const result = await app.get(PipelineService).fetch('PROJ-2');
      expect(result.exitCode).toBe(0);
      expect(paste).toHaveBeenCalledTimes(1);
      expect(agent).not.toHaveBeenCalled();

    const documents = await app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity)).find();
    const requirements = documents.filter((row) => row.kind === 'requirements');
    expect(requirements).toHaveLength(1);
    const stored = requirements[0]?.body ?? '';
    const record = JSON.parse(stored) as {
      tickets: { key: string; comments: { body: string }[]; acceptanceCriteria: string }[];
      epic: { key: string; summary: string; comments: { body: string }[] };
      epics: { key: string }[];
      files: { name: string; source: string; body: string | null }[];
      pages: { source: string; id: string; body: string }[];
    };
    expect(stored.trimStart().startsWith('{')).toBe(true);
    expect(stored.indexOf('"scope"')).toBeLessThan(stored.indexOf('"tickets"'));
    expect((JSON.parse(stored) as { scope: string[] }).scope).toEqual(['PROJ-2']);
    expect(record.tickets[0]?.key).toBe('PROJ-2');
    expect(record.tickets[0]?.acceptanceCriteria).toContain('Must ship');
    expect(record.tickets[0]?.comments.map((comment) => comment.body)).toEqual(
      expect.arrayContaining([expect.stringContaining('First note'), expect.stringContaining('Second note')]),
    );
    expect(record.epic?.key).toBe('PROJ-1');
    expect(record.epic?.summary).toBe('Big epic');
    expect(record.epic?.comments.map((comment) => comment.body)).toEqual(
      expect.arrayContaining([expect.stringContaining('Epic note')]),
    );
    expect(record.epics.map((epic) => epic.key)).toEqual(['PROJ-1']);
    expect(record.files.find((file) => file.name === 'note.txt')?.body).toBe('file-body');
    expect(record.files.find((file) => file.source === 'paste')?.body).toBe('pasted-body');
    expect(record.files.find((file) => file.body === 'spec-body')).toBeTruthy();
    expect(record.pages.find((page) => page.id === '42')?.body).toContain('Page');
    expect(existsSync(join(runDir, 'requirements.json'))).toBe(false);
    expect(existsSync(join(runDir, 'requirements.md'))).toBe(false);
    expect(existsSync(join(runDir, 'sources'))).toBe(false);
    expect(existsSync(join(runDir, 'state.json'))).toBe(false);
    const exchanges = await app.get<Repository<AgentExchangeEntity>>(getRepositoryToken(AgentExchangeEntity)).find();
    expect(exchanges).toHaveLength(0);
    const calls = await app.get<Repository<HttpCallEntity>>(getRepositoryToken(HttpCallEntity)).find();
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => !call.url.includes(TOKEN) && !(call.error ?? '').includes(TOKEN))).toBe(true);
    const db = await readFile(join(root, 'data', 'swarmloop.sqlite'));
    expect(db.includes(Buffer.from(TOKEN))).toBe(false);
    const run = await app.get(HistoryService).findRun('PROJ-2');
      expect(run?.status).toBe('waiting');
      expect(run?.currentStep).toBe('prepare');
    } finally {
      await app.close();
      await server.close();
    }
  });

  it('fetches a same-site browse link as an issue and does not ask for a paste', async () => {
    const hits: Record<string, number> = {};
    const server = await listen(200, 0, { issueHits: hits, linkIssue: true });
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-browse-'));
    const paste = jest.fn().mockResolvedValue('pasted-body');
    const app = await boot(root, server.base, 'direct', paste, jest.fn());
    try {
      const result = await app.get(PipelineService).fetch('PROJ-2');
      expect(result.exitCode).toBe(0);
      expect(paste).toHaveBeenCalledTimes(1);
      expect(String(paste.mock.calls[0]?.[0])).not.toContain('/browse/');
      expect(hits['PROJ-9']).toBe(1);
      expect(hits['PROJ-404']).toBe(1);
      expect(hits['PROJ-7']).toBe(1);
      expect(hits['PROJ-6']).toBe(1);
      const record = JSON.parse(await requirementsBody(app)) as { files: { url: string | null; body: string | null }[] };
      const linked = record.files.find((file) => file.url?.includes('/browse/PROJ-9'));
      expect(linked?.body).toContain('PROJ-9\nLinked story');
      expect(linked?.body).toContain('Status: Gotowe (done)');
      expect(linked?.body).toContain('Linked body');
      expect(linked?.body).toContain('Linked must');
      expect(linked?.body).toContain('Ada: Linked note');
      expect(requirementsBrief(await requirementsBody(app))).toContain('- PROJ-9: Linked story\nStatus: Gotowe (done)');
      const blocked = record.files.find((file) => file.url?.includes('/browse/PROJ-7'));
      expect(blocked?.body).toContain('Blocks this');
      expect(blocked?.body).not.toContain('Status:');
      const child = record.files.find((file) => file.url?.includes('/browse/PROJ-6'));
      expect(child?.body).toContain('Schema lives here');
      expect(child?.body).toContain('Scope moved here');
      expect(record.files.some((file) => file.url?.includes('/browse/PROJ-404'))).toBe(false);
    } finally {
      await app.close();
      await server.close();
    }
  });

  it('fails a bad issue fetch before writing a requirements record', async () => {
    const server = await listen(500);
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-fail-'));
    const app = await boot(root, server.base, 'direct', jest.fn(), jest.fn());
    try {
      const result = await app.get(PipelineService).fetch('PROJ-2');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('issue fetch failed');
      expect(existsSync(join(root, 'runs', 'PROJ-2', 'requirements.json'))).toBe(false);
      const documents = await app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity)).find();
      expect(documents.filter((row) => row.kind === 'requirements')).toHaveLength(0);
      const run = await app.get(HistoryService).findRun('PROJ-2');
      expect(run?.status).toBe('failed');
    } finally {
      await app.close();
      await server.close();
    }
  });

  it('names a missing credential and writes no requirements record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-cred-'));
    await writeEnv(root, 'http://127.0.0.1:9', 'direct', { JIRA_API_TOKEN: '' });
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn(), false);
    try {
      const result = await app.get(PipelineService).fetch('PROJ-2');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('JIRA_API_TOKEN');
      expect(existsSync(join(root, 'runs', 'PROJ-2', 'requirements.json'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('stores the ticket record without asking the model to rewrite it', async () => {
    const server = await listen();
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-empty-'));
    const agent = jest.fn().mockResolvedValue(emptyAgent());
    const app = await boot(root, server.base, 'agent', jest.fn().mockResolvedValue('pasted-body'), agent);
    try {
      const result = await app.get(PipelineService).fetch('PROJ-2');
      expect(agent).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(0);
      const record = JSON.parse(await requirementsBody(app)) as {
        tickets: { summary: string; comments: unknown[] }[];
        epic: { comments: unknown[] };
      };
      expect(record.tickets[0]?.summary).toBe('Ship the thing');
      expect(record.tickets[0]?.comments).toHaveLength(2);
      expect(record.epic?.comments).toHaveLength(1);
      const run = await app.get(HistoryService).findRun('PROJ-2');
      expect(run?.status).toBe('waiting');
    } finally {
      await app.close();
      await server.close();
    }
  });

  it('leaves state unchanged when the step input is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-missing-'));
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn());
    try {
      const result = await app.get(PipelineService).step('prepare', 'PROJ-3');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('requirements is missing');
      expect(await app.get(HistoryService).findRun('PROJ-3')).toBeNull();
      expect(existsSync(join(root, 'runs', 'PROJ-3', 'state.json'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('blocks a step that is not implemented', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-later-'));
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn());
    const history = app.get(HistoryService);
    const seeded = await history.begin('PROJ-4', 'requirements');
    seeded.status = 'waiting';
    await history.saveRun(seeded);
    const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    await documents.save(
      documents.create({
        runId: seeded.id,
        stepStatId: 0,
        kind: 'merge_request',
        attempt: 1,
        body: 'project: group/demo\n',
        path: '',
        createdAt: new Date().toISOString(),
      }),
    );
    try {
      const result = await app.get(PipelineService).step('done', 'PROJ-4');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('not implemented');
      const run = await app.get(HistoryService).findRun('PROJ-4');
      expect(run?.status).toBe('blocked');
      expect(run?.currentStep).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('requires a prompt before requirements and fetches a task number', async () => {
    const server = await listen();
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-task-'));
    const app = await boot(root, server.base, 'direct', jest.fn().mockResolvedValue('pasted-body'), jest.fn());
    try {
      const missing = await app.get(PipelineService).run('widget');
      expect(missing.exitCode).toBe(1);
      expect(missing.message).toContain('prompt is missing');
      expect(await app.get(HistoryService).findRun('widget')).toBeNull();
      const result = await app.get(PipelineService).run('PROJ-2', { prompt: 'Do the ticket' });
      expect(result.exitCode).toBe(0);
      const requirements = await requirementsBody(app, 'PROJ-2');
      expect(requirements).toContain('Do the ticket');
      expect(requirements).toContain('Ship the thing');
      expect(existsSync(join(root, 'runs', 'PROJ-2', 'sources'))).toBe(false);
      const slack = await app.get(PipelineService).run('notes', { prompt: 'see https://acme.slack.com/archives/C1' });
      expect(slack.exitCode).toBe(1);
      expect(slack.message).toContain('slack is not readable');
      expect(existsSync(join(root, 'runs', 'notes', 'requirements.json'))).toBe(false);
    } finally {
      await app.close();
      await server.close();
    }
  });

  it('writes a prompt as requirements and does not call Jira', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prompt-'));
    await writeEnv(root, '', 'direct', { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' });
    const app = await boot(root, '', 'direct', jest.fn(), jest.fn(), false);
    try {
      const result = await app.get(PipelineService).run('widget', { prompt: 'Ship the widget' });
      expect(result.exitCode).toBe(0);
      const record = JSON.parse(await requirementsBody(app, 'widget')) as {
        prompt: string;
        tickets: unknown[];
        epic: unknown;
        files: unknown[];
        pages: unknown[];
      };
      expect(record.prompt).toBe('Ship the widget\n');
      expect(record.tickets).toEqual([]);
      expect(record.epic).toBeNull();
      expect(record.files).toEqual([]);
      expect(record.pages).toEqual([]);
      expect(existsSync(join(root, 'runs', 'widget', 'sources'))).toBe(false);
      expect(existsSync(join(root, 'runs', 'widget', 'requirements.json'))).toBe(false);
      const calls = await app.get<Repository<HttpCallEntity>>(getRepositoryToken(HttpCallEntity)).find();
      expect(calls).toHaveLength(0);
      const run = await app.get(HistoryService).findRun('widget');
      expect(run?.status).toBe('waiting');
      expect(run?.currentStep).toBe('prepare');
    } finally {
      await app.close();
    }
  });

  it('rejects an empty prompt before creating a run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-blank-'));
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn());
    try {
      const result = await app.get(PipelineService).run('widget', { prompt: '  ', promptFile: 'also.txt' });
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('prompt and prompt-file are both set');
      const empty = await app.get(PipelineService).run('widget', { prompt: '   ' });
      expect(empty.exitCode).toBe(1);
      expect(empty.message).toContain('prompt is empty');
      expect(await app.get(HistoryService).findRun('widget')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('reads a prompt file and rejects a key that is not a run id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-file-'));
    const file = join(root, 'brief.md');
    await writeFile(file, 'From a file\n');
    await writeEnv(root, '', 'direct', { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' });
    const app = await boot(root, '', 'direct', jest.fn(), jest.fn(), false);
    try {
      const bad = await app.get(PipelineService).run('Not A Key');
      expect(bad.exitCode).toBe(1);
      expect(bad.message).toContain('is not a run id');
      const result = await app.get(PipelineService).step('requirements', 'from-file', { promptFile: file });
      expect(result.exitCode).toBe(0);
      const record = JSON.parse(await requirementsBody(app, 'from-file')) as {
        prompt: string;
      };
      expect(record.prompt).toBe('From a file\n');
      expect(existsSync(join(root, 'runs', 'from-file', 'requirements.json'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('accepts a local checkout for code review without an implementation record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-vendor-'));
    const checkout = await mkdtemp(join(tmpdir(), 'swarmloop-checkout-'));
    const now = new Date().toISOString();
    const agent = jest.fn().mockResolvedValue({
      responseText: 'decision: ok\n',
      chatId: null,
      tokensIn: 1,
      tokensOut: 1,
      usd: 0,
      killReason: null,
      exitCode: 0,
      resumed: false,
      calls: 1,
      samples: [],
      durationMs: 1,
      startedAt: now,
      finishedAt: now,
    });
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), agent, true, {
      assertReady: jest.fn().mockResolvedValue(undefined),
    });
    try {
      const missing = await app.get(PipelineService).step('code-review', 'vendor-api');
      expect(missing.exitCode).toBe(1);
      expect(missing.message).toContain('implementation is missing');
      expect(await app.get(HistoryService).findRun('vendor-api')).toBeNull();
      const review = await app.get(PipelineService).step('code-review', 'vendor-api', { path: checkout });
      expect(review.exitCode).toBe(0);
      expect(review.message).not.toContain('implementation is missing');
      const run = await app.get(HistoryService).findRun('vendor-api');
      expect(run?.targetPath).toBe(realpathSync(checkout));
      expect(existsSync(join(root, 'runs', 'vendor-api', 'target.json'))).toBe(false);
      expect(run?.status).toBe('waiting');
      expect(run?.currentStep).toBe('commit');
      expect(run?.attemptsReview).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('retries a failed requirements read from the stored prompt', async () => {
    const server = await listen(200, 1);
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-retry-'));
    const app = await boot(root, server.base, 'direct', jest.fn().mockResolvedValue('pasted-body'), jest.fn());
    const history = app.get(HistoryService);
    try {
      const first = await app.get(PipelineService).run('PROJ-2', { prompt: 'Do the ticket' });
      expect(first.exitCode).toBe(1);
      const failed = await history.findRun('PROJ-2');
      expect(failed?.status).toBe('failed');
      expect(failed?.currentStep).toBe('requirements');
      expect(failed?.prompt).toContain('Do the ticket');
      expect(failed?.ownerPid).toBeNull();

      const second = await app.get(PipelineService).run('PROJ-2');
      expect(second.exitCode).toBe(0);
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      expect((await documents.find()).filter((row) => row.kind === 'requirements')).toHaveLength(1);
      const fetched = await app.get(PipelineService).fetch('PROJ-2');
      expect(fetched.exitCode).toBe(0);
      const requirementRows = (await documents.find()).filter((row) => row.kind === 'requirements');
      expect(requirementRows).toHaveLength(1);
      expect(requirementRows[0]?.body).toContain('Do the ticket');
      expect((await history.findRun('PROJ-2'))?.currentStep).toBe('prepare');
      const advanced = await history.findRun('PROJ-2');
      expect(advanced?.currentStep).toBe('prepare');
      if (advanced) {
        advanced.currentStep = 'branch';
        advanced.status = 'waiting';
        await history.saveRun(advanced);
      }
      const third = await app.get(PipelineService).step('requirements', 'PROJ-2');
      expect(third.exitCode).toBe(0);
      expect((await documents.find()).filter((row) => row.kind === 'requirements')).toHaveLength(1);
      expect((await history.findRun('PROJ-2'))?.currentStep).toBe('branch');
      expect((await history.findRun('PROJ-2'))?.status).toBe('waiting');
    } finally {
      await app.close();
      await server.close();
    }
  });

  it('retries requirements from the issue that failed', async () => {
    const hits: Record<string, number> = {};
    const server = await listen(200, 0, { issueHits: hits, failOnce: 'PROJ-8' });
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-partial-'));
    const app = await boot(root, server.base, 'direct', jest.fn().mockResolvedValue('pasted-body'), jest.fn());
    try {
      const first = await app.get(PipelineService).run('PROJ-2', { prompt: 'Also PROJ-8' });
      expect(first.exitCode).toBe(1);
      expect(hits['PROJ-2']).toBe(1);
      const second = await app.get(PipelineService).run('PROJ-2');
      expect(second.exitCode).toBe(0);
      expect(hits['PROJ-2']).toBe(1);
      expect(hits['PROJ-8']).toBe(2);
      const record = JSON.parse(await requirementsBody(app, 'PROJ-2')) as { tickets: { key: string }[]; prompt: string };
      expect(record.prompt).toContain('Also PROJ-8');
      expect(record.tickets.map((ticket) => ticket.key)).toEqual(['PROJ-2', 'PROJ-8']);
    } finally {
      await app.close();
      await server.close();
    }
  });

  it('refuses research when the sandbox cannot start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-sandbox-'));
    mkdirSync(join(root, 'worktrees', 'PROJ-17'), { recursive: true });
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn(), true, {
      assertReady: jest.fn().mockRejectedValue(new SwarmloopError('docker is not running')),
    });
    try {
      const result = await app.get(PipelineService).step('research', 'PROJ-17');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('docker is not running');
      expect(result.message).not.toContain('not implemented');
      const run = await app.get(HistoryService).findRun('PROJ-17');
      expect(run?.currentStep).toBe('research');
      expect(run?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('does not move backward when an earlier step fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-rewind-'));
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn());
    const history = app.get(HistoryService);
    const seeded = await history.begin('PROJ-6', 'requirements');
    seeded.status = 'waiting';
    seeded.currentStep = 'implement';
    await history.saveRun(seeded);
    const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    await documents.save(
      documents.create({
        runId: seeded.id,
        stepStatId: 0,
        kind: 'repos',
        attempt: 1,
        body: '{}\n',
        path: '',
        createdAt: new Date().toISOString(),
      }),
    );
    try {
      const result = await app.get(PipelineService).step('branch', 'PROJ-6');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('requirements is missing');
      const run = await history.findRun('PROJ-6');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('continues a run whose owner process is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-dead-'));
    await writeEnv(root, '', 'direct', { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' });
    const app = await boot(root, '', 'direct', jest.fn(), jest.fn(), false);
    const history = app.get(HistoryService);
    try {
      const seeded = await history.begin('widget', 'requirements');
      seeded.status = 'running';
      seeded.ownerPid = 2_147_483_646;
      seeded.prompt = 'Ship the widget\n';
      seeded.currentStep = 'requirements';
      await history.saveRun(seeded);
      const result = await app.get(PipelineService).run('widget');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('requirements done');
      const run = await history.findRun('widget');
      expect(run?.currentStep).toBe('prepare');
      expect(run?.ownerPid).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('refuses a second process while the run is running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-lock-'));
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn());
    await app.get(HistoryService).begin('PROJ-5', 'requirements');
    try {
      const result = await app.get(PipelineService).run('PROJ-5');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('already running');
      const run = await app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity)).findOneBy({ key: 'PROJ-5' });
      expect(run?.status).toBe('running');
    } finally {
      await app.close();
    }
  });
});

async function requirementsBody(app: TestingModule, key?: string): Promise<string> {
  const documents = await app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity)).find();
  const runs = key ? await app.get<Repository<RunEntity>>(getRepositoryToken(RunEntity)).find() : [];
  const runId = key ? runs.find((run) => run.key === key)?.id : undefined;
  const row = documents.find((document) => document.kind === 'requirements' && (runId === undefined || document.runId === runId));
  if (!row) {
    throw new Error('requirements record is missing');
  }
  return row.body;
}

async function boot(
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

async function writeEnv(
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
    MODEL_RESEARCH: 'grok-4.7',
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

function emptyAgent(): AgentRunResult {
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

async function listen(
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
          description: doc([
            text('See '),
            link('the page', `${origin(req)}/wiki/spaces/ENG/pages/42/Title`),
          ]),
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
        fields: { summary: 'Child change', issuetype: { name: 'Sub-task' }, description: doc([text('Schema lives here')]) },
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

function origin(req: { headers: { host?: string } }): string {
  return `http://${req.headers.host}`;
}

function send(res: import('http').ServerResponse, body: unknown): void {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function doc(content: unknown[]): unknown {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content }] };
}

function text(value: string): unknown {
  return { type: 'text', text: value };
}

function link(value: string, href: string): unknown {
  return { type: 'text', text: value, marks: [{ type: 'link', attrs: { href } }] };
}

void Server;
