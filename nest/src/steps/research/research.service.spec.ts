import 'reflect-metadata';
import { EventEmitter } from 'events';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PassThrough } from 'stream';
import { Repository } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { DocumentEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER, AgentRunInput, AgentRunResult } from '../../limits/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { SandboxService } from '../../sandbox/sandbox.service';

describe('research step', () => {
  it('stores repos and waits while questions are open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-20', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'worktrees', 'PROJ-20', 'catalog-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(['summary:', '- looking', 'questions:', '- which field is optional?'].join('\n')));
    const app = await boot(root, agent);
    const history = app.get(HistoryService);
    const seeded = await history.begin('PROJ-20', 'prepare');
    seeded.status = 'waiting';
    seeded.currentStep = 'research';
    await history.saveRun(seeded);
    await history.putDocument(seeded, 'requirements', '{"prompt":"ship the field"}\n');
    try {
      const first = await app.get(PipelineService).step('research', 'PROJ-20');
      expect(first.exitCode).toBe(0);
      expect(first.message).toContain('which field is optional?');
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.mode).toBe('plan');
      expect(input.model).toBe('opus-5.5-extra-high');
      expect(input.timeLimitMs).toBe(15 * 60 * 1000);
      expect(input.prompt).toContain('ship the field');
      expect(input.mounts.map((mount) => mount.containerPath)).toEqual(['/work/billing-api', '/work/catalog-api']);
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      expect((await documents.find({ where: { kind: 'repos' } }))[0]?.body).toBe('billing-api\ncatalog-api\n');
      expect((await documents.find({ where: { kind: 'questions' } }))[0]?.body).toContain('which field is optional?');
      expect((await history.findRun('PROJ-20'))?.currentStep).toBe('research');
      expect((await history.findRun('PROJ-20'))?.status).toBe('waiting');

      await app.get(PipelineService).step('research', 'PROJ-20');
      expect(await documents.find({ where: { kind: 'repos' } })).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('mounts only the stored project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-project-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-22', 'app'), { recursive: true });
    mkdirSync(join(root, 'worktrees', 'PROJ-22', 'other'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(['summary:', '- looking', 'questions:', '- none'].join('\n')));
    const app = await boot(root, agent);
    const history = app.get(HistoryService);
    const seeded = await history.begin('PROJ-22', 'prepare');
    seeded.status = 'waiting';
    seeded.currentStep = 'research';
    seeded.projects = 'app\n';
    await history.saveRun(seeded);
    await history.putDocument(seeded, 'requirements', '{"prompt":"ship the field"}\n');
    try {
      const done = await app.get(PipelineService).step('research', 'PROJ-22');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.mounts).toEqual([{ hostPath: join(root, 'worktrees', 'PROJ-22', 'app'), containerPath: '/work/app' }]);
      expect(input.prompt).toContain('app');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      expect((await documents.find({ where: { kind: 'repos' } }))[0]?.body).toBe('app\n');
    } finally {
      await app.close();
    }
  });

  it('advances to plan when research has no open questions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-clear-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-21', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(['summary:', '- looking', 'questions:', '- none'].join('\n')));
    const app = await boot(root, agent);
    const history = app.get(HistoryService);
    const seeded = await history.begin('PROJ-21', 'prepare');
    seeded.status = 'waiting';
    seeded.currentStep = 'research';
    await history.saveRun(seeded);
    await history.putDocument(seeded, 'requirements', '{"prompt":"ship it"}\n');
    try {
      const done = await app.get(PipelineService).step('research', 'PROJ-21');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('billing-api');
      const run = await history.findRun('PROJ-21');
      expect(run?.currentStep).toBe('plan');
      expect(run?.status).toBe('waiting');
      expect(run?.agentCalls).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('relaunches a time kill until the answer is finished', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-time-'));
    await writeEnv(root, { RESEARCH_TIMEOUT_MS: '0' });
    const spawn = scripted([
      chatStream('research-chat', 'partial-1'),
      chatStream('research-chat', 'partial-2'),
      doneStream(FINISHED),
    ]);
    const app = await bootLive(root, spawn);
    try {
      const history = await seed(app, root, 'PROJ-30');
      const done = await app.get(PipelineService).step('research', 'PROJ-30');
      expect(done.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(launchedPrompt(spawn.mock.calls[1])).toContain('You were interrupted before the summary');
      expect(launchedPrompt(spawn.mock.calls[1])).not.toContain('Always write in English');
      expect(launchedPrompt(spawn.mock.calls[2])).toContain('You were interrupted before the summary');
      expect(resumeArg(spawn.mock.calls[1])).toBe('research-chat');
      expect(resumeArg(spawn.mock.calls[2])).toBe('research-chat');
      const run = await history.findRun('PROJ-30');
      expect(run?.currentStep).toBe('plan');
      expect(run?.agentCalls).toBe(3);
      const stats = await history.listStats(run?.id ?? 0);
      expect(stats.filter((item) => item.step === 'research')).toHaveLength(1);
      expect(stats.find((item) => item.step === 'research')?.killReason ?? null).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('does not relaunch a time kill that has no chat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-time-fresh-'));
    await writeEnv(root, { RESEARCH_TIMEOUT_MS: '0' });
    const spawn = scripted([chatStream(null), doneStream(FINISHED)]);
    const app = await bootLive(root, spawn);
    try {
      await seed(app, root, 'PROJ-31');
      const done = await app.get(PipelineService).step('research', 'PROJ-31');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('process killed: time');
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(launchedPrompt(spawn.mock.calls[0])).toContain('ship the field');
    } finally {
      await app.close();
    }
  });

  it('stops after the third time kill', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-time-stop-'));
    await writeEnv(root, { RESEARCH_TIMEOUT_MS: '0' });
    const spawn = scripted([
      chatStream('research-chat', 'partial-1'),
      chatStream('research-chat', 'partial-2'),
      chatStream('research-chat', 'partial-3'),
      doneStream(FINISHED),
    ]);
    const app = await bootLive(root, spawn);
    try {
      const history = await seed(app, root, 'PROJ-32');
      const done = await app.get(PipelineService).step('research', 'PROJ-32');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('process killed: time');
      expect(spawn).toHaveBeenCalledTimes(3);
      expect(launchedPrompt(spawn.mock.calls[2])).toContain('You were interrupted before the summary');
      const run = await history.findRun('PROJ-32');
      expect(run?.status).toBe('failed');
      expect(run?.currentStep).toBe('research');
      const stats = await history.listStats(run?.id ?? 0);
      expect(stats.filter((item) => item.step === 'research')).toHaveLength(1);
      expect(stats.find((item) => item.step === 'research')?.killReason).toBe('process killed: time');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      expect(await documents.count({ where: { kind: 'questions' } })).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('relaunches an idle kill in the same chat', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-idle-'));
    await writeEnv(root, { IDLE_TIMEOUT_MS: '0' });
    const spawn = scripted([chatStream('research-chat', 'idle-partial'), doneStream(FINISHED)]);
    const app = await bootLive(root, spawn);
    try {
      const history = await seed(app, root, 'PROJ-33');
      const done = await app.get(PipelineService).step('research', 'PROJ-33');
      expect(done.exitCode).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(launchedPrompt(spawn.mock.calls[1])).toContain('You were interrupted before the summary');
      expect(resumeArg(spawn.mock.calls[1])).toBe('research-chat');
      const run = await history.findRun('PROJ-33');
      expect(run?.currentStep).toBe('plan');
      const stats = await history.listStats(run?.id ?? 0);
      expect(stats.filter((item) => item.step === 'research')).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('skips another launch on an automatic hop at the call ceiling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-ceiling-'));
    await writeEnv(root);
    const agent = jest.fn(async () => killed('time'));
    const app = await boot(root, agent);
    try {
      await seed(app, root, 'PROJ-34', 19);
      const done = await app.get(PipelineService).step('research', 'PROJ-34', { auto: true });
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('process killed: time');
      expect(agent).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it('does not relaunch a time kill once agent calls reach the cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-manual-'));
    await writeEnv(root, { RESEARCH_TIMEOUT_MS: '0' });
    const spawn = scripted([chatStream('research-chat'), doneStream(FINISHED)]);
    const app = await bootLive(root, spawn);
    try {
      await seed(app, root, 'PROJ-35', 19);
      const done = await app.get(PipelineService).step('research', 'PROJ-35');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('process killed: time');
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

const FINISHED = ['summary:', '- looking', 'questions:', '- none'].join('\n');

function killed(reason: 'time' | 'idle', chatId: string | null = 'research-chat'): AgentRunResult {
  return { ...result('partial'), chatId, killReason: reason, exitCode: 1 };
}

async function seed(
  app: Awaited<ReturnType<typeof boot>>,
  root: string,
  key: string,
  agentCalls = 0,
): Promise<HistoryService> {
  mkdirSync(join(root, 'worktrees', key, 'billing-api'), { recursive: true });
  const history = app.get(HistoryService);
  const seeded = await history.begin(key, 'prepare');
  seeded.status = 'waiting';
  seeded.currentStep = 'research';
  seeded.agentCalls = agentCalls;
  await history.saveRun(seeded);
  await history.putDocument(seeded, 'requirements', '{"prompt":"ship the field"}\n');
  return history;
}

function result(responseText: string): AgentRunResult {
  const now = new Date().toISOString();
  return {
    responseText,
    chatId: 'chat-1',
    tokensIn: 10,
    tokensOut: 4,
    usd: 0.01,
    killReason: null,
    exitCode: 0,
    resumed: false,
    calls: 1,
    samples: [],
    durationMs: 5,
    startedAt: now,
    finishedAt: now,
  };
}

async function boot(root: string, agent: jest.Mock) {
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: agent })
    .overrideProvider(SandboxService)
    .useValue({ assertReady: jest.fn().mockResolvedValue(undefined) })
    .compile();
}

async function bootLive(root: string, spawn: jest.Mock): ReturnType<typeof boot> {
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(join(root, 'data', 'price-cache-cursor.json'), `${JSON.stringify({ fetchedAt: new Date().toISOString(), prices: {} })}\n`);
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(SandboxService)
    .useValue({
      assertReady: jest.fn().mockResolvedValue(undefined),
      spawn,
      stats: jest.fn().mockResolvedValue({ cpuPercent: 0, rssBytes: 0 }),
      kill: jest.fn().mockResolvedValue(undefined),
    })
    .compile();
}

function scripted(chunks: string[]): jest.Mock {
  const pending = [...chunks];
  return jest.fn(async () => {
    const next = pending.shift();
    if (!next) {
      throw new Error('unexpected spawn');
    }
    return fakeChild([next], 0);
  });
}

function launchedPrompt(call: unknown[] | undefined): string {
  const command = (call?.[0] as { command?: string[] } | undefined)?.command ?? [];
  return command[command.length - 1] ?? '';
}

function resumeArg(call: unknown[] | undefined): string | null {
  const command = (call?.[0] as { command?: string[] } | undefined)?.command ?? [];
  const at = command.indexOf('--resume');
  return at < 0 ? null : (command[at + 1] ?? null);
}

function chatStream(chatId: string | null, note?: string): string {
  const noteLine = note ? `${JSON.stringify({ type: 'thinking', text: note })}\n` : '';
  const idLine = chatId ? `${JSON.stringify({ session_id: chatId })}\n` : '';
  return `${noteLine}${idLine}` || `${JSON.stringify({ type: 'thinking', text: 'partial' })}\n`;
}

function doneStream(text: string): string {
  return `${JSON.stringify({ type: 'result', result: text })}\n`;
}

function fakeChild(chunks: string[], code: number): EventEmitter {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = new EventEmitter();
  for (const chunk of chunks) {
    stdout.write(chunk);
  }
  const on = child.on.bind(child);
  child.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
    const returned = on(event, listener);
    if (event === 'close') {
      setImmediate(() => child.emit('close', code));
    }
    return returned;
  }) as typeof child.on;
  return Object.assign(child, { stdout, stderr, containerName: 'box', kill: () => true });
}

async function writeEnv(root: string, overrides: Record<string, string> = {}): Promise<void> {
  const values: Record<string, string> = {
    RUNTIME: 'cursor',
    REQUIREMENTS_VIA: 'direct',
    ISSUE_TRACKER: 'jira',
    JIRA_BASE_URL: '',
    JIRA_EMAIL: '',
    JIRA_API_TOKEN: '',
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
    ...overrides,
    SWARMLOOP_ROOT: root,
  };
  await writeFile(join(root, '.env'), `${Object.entries(values).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}
