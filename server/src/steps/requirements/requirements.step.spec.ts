import { handoffText } from '../shared/handoff';
import 'reflect-metadata';
import { resultAnswer } from '../../testing/result-answer';

import { getRepositoryToken } from '@nestjs/typeorm';

import { mkdtemp, readFile, writeFile } from 'fs/promises';

import { existsSync, mkdirSync, realpathSync } from 'fs';

import { tmpdir } from 'os';

import { join } from 'path';

import type { Repository } from 'typeorm';

import { AgentExchangeEntity, DocumentEntity, HttpCallEntity, StepStatEntity } from '../../history/entities';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { PipelineService } from '../../pipeline/pipeline.service';

import { HostUnavailable, SwarmloopError } from '../../core/swarmloop-error';

import type { IssueTracker } from '../../integrations/issue-tracker/issue-tracker';

import { ISSUE_TRACKER } from '../../integrations/issue-tracker/tokens';

import { RemoteRepositories } from '../prepare/remote-repositories.service';

import { StepEventLog } from '../../history/step-event.log';

import { requirementsBrief } from '../shared/requirements-brief';

import { TOKEN, requirementsBody, boot, writeEnv, emptyAgent, listen } from './requirements.step.spec-helpers';

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
      const run = await app.get(RunRepository).findRun('PROJ-2');
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
      const record = JSON.parse(await requirementsBody(app)) as {
        files: { url: string | null; body: string | null }[];
      };
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
    const server = await listen(403);
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-fail-'));
    const app = await boot(root, server.base, 'direct', jest.fn(), jest.fn());
    try {
      const result = await app.get(PipelineService).fetch('PROJ-2');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('issue fetch failed');
      expect(existsSync(join(root, 'runs', 'PROJ-2', 'requirements.json'))).toBe(false);
      const documents = await app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity)).find();
      expect(documents.filter((row) => row.kind === 'requirements')).toHaveLength(0);
      const run = await app.get(RunRepository).findRun('PROJ-2');
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
      const run = await app.get(RunRepository).findRun('PROJ-2');
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
      expect(await app.get(RunRepository).findRun('PROJ-3')).toBeNull();
      expect(existsSync(join(root, 'runs', 'PROJ-3', 'state.json'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('reports requirements failed when the step throws something other than a SwarmloopError', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-throw-'));
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn());
    try {
      jest.spyOn(app.get(RunRepository), 'begin').mockRejectedValueOnce(new Error('database is locked'));
      const result = await app.get(PipelineService).step('requirements', 'PROJ-2', { prompt: 'Build it' });
      expect(result).toEqual({
        exitCode: 1,
        message: expect.stringMatching(/^requirements failed: database is locked \(E-[0-9a-z]{8}\)$/),
      });
    } finally {
      await app.close();
    }
  });

  it('waits with HOST_UNAVAILABLE and its next try when the tracker stays down', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-outage-'));
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn());
    const retryAt = '2026-11-12T15:00:00.000Z';
    try {
      jest
        .spyOn(app.get<IssueTracker>(ISSUE_TRACKER), 'fetch')
        .mockRejectedValue(new HostUnavailable('jira.example.com', 'HTTP 503', retryAt));
      await app.get(PipelineService).step('requirements', 'PROJ-2', { prompt: 'Build it' });
      const run = await app.get(RunRepository).findRun('PROJ-2');
      expect(run?.status).toBe('waiting');
      expect(JSON.parse(run?.stateReason ?? '{}')).toMatchObject({ code: 'HOST_UNAVAILABLE', retryAt });
    } finally {
      await app.close();
    }
  });

  it('keeps the no-visit result when the prompt cannot be saved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-save-'));
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn());
    try {
      const runs = app.get(RunRepository);
      const save = runs.saveRun.bind(runs);
      jest
        .spyOn(runs, 'saveRun')
        .mockImplementation((run) => (run.prompt ? Promise.reject(new Error('disk full')) : save(run)));
      const result = await app.get(PipelineService).step('requirements', 'PROJ-2', { prompt: 'Build it' });
      expect(result).toEqual({
        exitCode: 1,
        message: expect.stringMatching(/^requirements failed: disk full \(E-[0-9a-z]{8}\)$/),
      });
      const stats = app.get<Repository<StepStatEntity>>(getRepositoryToken(StepStatEntity));
      expect(await stats.count()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('blocks a step that is not implemented', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-later-'));
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), jest.fn());
    const runs = app.get(RunRepository);
    const seeded = await runs.begin('PROJ-4', 'requirements');
    seeded.status = 'waiting';
    await runs.saveRun(seeded);
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
      const run = await app.get(RunRepository).findRun('PROJ-4');
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
      expect(await app.get(RunRepository).findRun('widget')).toBeNull();
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
      const run = await app.get(RunRepository).findRun('widget');
      expect(run?.status).toBe('waiting');
      expect(run?.currentStep).toBe('prepare');
    } finally {
      await app.close();
    }
  });

  it('continues with the prompt and notes a ticket Jira does not know', async () => {
    const server = await listen(404);
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-404-'));
    await writeEnv(root, server.base, 'direct', { JIRA_PROJECTS: 'PROJ' });
    const app = await boot(root, server.base, 'direct', jest.fn(), jest.fn(), false);
    try {
      const result = await app.get(PipelineService).run('widget', { prompt: 'Do PROJ-1 today' });
      expect(result.exitCode).toBe(0);
      const record = JSON.parse(await requirementsBody(app, 'widget')) as { prompt: string; tickets: unknown[] };
      expect(record.prompt).toBe('Do PROJ-1 today\n');
      expect(record.tickets).toEqual([]);
      const handoff = handoffText(await app.get(DocumentRepository).latestBody('widget', 'handoff'));
      expect(handoff).toContain('- requirements done');
      expect(handoff).toContain('- PROJ-1 was not found in Jira');
      expect((await app.get(RunRepository).findRun('widget'))?.status).not.toBe('failed');
    } finally {
      await app.close();
      await server.close();
    }
  });

  it('blocks once when the typed run id is a Jira key and Jira is not set up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-block-'));
    await writeEnv(root, '', 'direct', { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' });
    const app = await boot(root, '', 'direct', jest.fn(), jest.fn(), false);
    try {
      const result = await app.get(PipelineService).run('PROJ-123', { prompt: 'Do the ticket' });
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain(
        'this run id is a Jira key, but JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are not set',
      );
      const run = await app.get(RunRepository).findRun('PROJ-123');
      expect(run?.status).toBe('blocked');
      expect(run?.currentStep).toBe('requirements');
      expect(JSON.parse(run?.stateReason ?? '{}')).toMatchObject({ code: 'INPUT_MISSING' });
      const documents = await app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity)).find();
      expect(documents.filter((row) => row.kind === 'requirements')).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('blocks with INPUT_MISSING when a run names a repository outside SWARMLOOP_REPOS', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-repos-'));
    await writeEnv(root, '', 'direct', { SWARMLOOP_REPOS: 'api' });
    const app = await boot(root, '', 'direct', jest.fn(), jest.fn(), false);
    try {
      const runs = app.get(RunRepository);
      const created = await runs.openWaiting('widget', '');
      created.projects = 'billing\n';
      await runs.saveRun(created);
      const result = await app.get(PipelineService).step('requirements', 'widget', { prompt: 'Do it' });
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('billing is not in SWARMLOOP_REPOS');
      const run = await app.get(RunRepository).findRun('widget');
      expect(run?.status).toBe('blocked');
      expect(JSON.parse(run?.stateReason ?? '{}')).toMatchObject({ code: 'INPUT_MISSING' });
    } finally {
      await app.close();
    }
  });

  it('clones a repository that is not a folder yet as an activity, and leaves a folder that exists alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-clone-'));
    const checkouts = join(root, 'checkouts');
    mkdirSync(join(checkouts, 'local'), { recursive: true });
    await writeEnv(root, '', 'direct', { CHECKOUTS_ROOT: checkouts, SWARMLOOP_REPOS: '' });
    const app = await boot(root, '', 'direct', jest.fn(), jest.fn(), false);
    try {
      const clone = jest
        .spyOn(app.get(RemoteRepositories), 'clone')
        .mockImplementation(async (name) => void mkdirSync(join(checkouts, name)));
      const runs = app.get(RunRepository);
      const created = await runs.openWaiting('widget', '');
      created.projects = 'fresh\nlocal\n';
      created.startedBy = 'ana';
      await runs.saveRun(created);
      const result = await app.get(PipelineService).step('requirements', 'widget', { prompt: 'Do it' });
      expect(result.exitCode).toBe(0);
      expect(clone.mock.calls).toEqual([['fresh', 'ana']]);
      const run = await app.get(RunRepository).findRun('widget');
      const page = await app.get(StepEventLog).page(run?.id ?? 0, { limit: 500 });
      expect(page.events.filter((event) => event.kind === 'activity.finished')).toMatchObject([
        { title: 'Clone fresh', result: 'cloned', failed: false },
      ]);
    } finally {
      await app.close();
    }
  });

  it('does not fail requirements for words that only look like keys', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plain-'));
    await writeEnv(root, '', 'direct', { JIRA_BASE_URL: '', JIRA_EMAIL: '', JIRA_API_TOKEN: '' });
    const app = await boot(root, '', 'direct', jest.fn(), jest.fn(), false);
    try {
      const result = await app.get(PipelineService).run('widget', { prompt: 'Store UTF-8 text, hash with SHA-256' });
      expect(result.exitCode).toBe(0);
      expect(await requirementsBody(app, 'widget')).toContain('UTF-8');
      const calls = await app.get<Repository<HttpCallEntity>>(getRepositoryToken(HttpCallEntity)).find();
      expect(calls).toHaveLength(0);
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
      expect(await app.get(RunRepository).findRun('widget')).toBeNull();
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
    const checkout = join(root, 'worktrees', 'checkout');
    mkdirSync(checkout, { recursive: true });
    const now = new Date().toISOString();
    const answer = (step: string): string =>
      step.endsWith('report')
        ? resultAnswer('Holds.', { whatChanged: 'x', codeReview: 'ok' })
        : resultAnswer('Fine.', { decision: 'ok', review: 'Fine.', summary: [] });
    const agent = jest.fn().mockImplementation(async (input: { step: string }) => ({
      responseText: answer(input.step),
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
    }));
    const app = await boot(root, 'http://127.0.0.1:9', 'direct', jest.fn(), agent, true, {
      assertReady: jest.fn().mockResolvedValue(undefined),
    });
    try {
      const missing = await app.get(PipelineService).step('code-review', 'vendor-api');
      expect(missing.exitCode).toBe(1);
      expect(missing.message).toContain('implementation is missing');
      expect(await app.get(RunRepository).findRun('vendor-api')).toBeNull();
      const review = await app.get(PipelineService).step('code-review', 'vendor-api', { path: checkout });
      expect(review.exitCode).toBe(0);
      expect(review.message).not.toContain('implementation is missing');
      const run = await app.get(RunRepository).findRun('vendor-api');
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
    const runs = app.get(RunRepository);
    try {
      const first = await app.get(PipelineService).run('PROJ-2', { prompt: 'Do the ticket' });
      expect(first.exitCode).toBe(1);
      const failed = await runs.findRun('PROJ-2');
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
      expect((await runs.findRun('PROJ-2'))?.currentStep).toBe('prepare');
      const advanced = await runs.findRun('PROJ-2');
      expect(advanced?.currentStep).toBe('prepare');
      if (advanced) {
        advanced.currentStep = 'branch';
        advanced.status = 'waiting';
        await runs.saveRun(advanced);
      }
      const third = await app.get(PipelineService).step('requirements', 'PROJ-2');
      expect(third.exitCode).toBe(0);
      expect((await documents.find()).filter((row) => row.kind === 'requirements')).toHaveLength(1);
      expect((await runs.findRun('PROJ-2'))?.currentStep).toBe('branch');
      expect((await runs.findRun('PROJ-2'))?.status).toBe('waiting');
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
      const record = JSON.parse(await requirementsBody(app, 'PROJ-2')) as {
        tickets: { key: string }[];
        prompt: string;
      };
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
      const run = await app.get(RunRepository).findRun('PROJ-17');
      expect(run?.currentStep).toBe('research');
      expect(run?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });
});
