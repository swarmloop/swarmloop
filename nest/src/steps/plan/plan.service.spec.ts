import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Repository } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { DocumentEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER, AgentRunInput, AgentRunResult } from '../../limits/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { SandboxService } from '../../sandbox/sandbox.service';
import { SwarmloopError } from '../../swarmloop-error';

describe('plan step', () => {
  it('stores the checklist and advances to plan review', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-40', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'worktrees', 'PROJ-40', 'other'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(['plan:', '- add the field', '- cover the empty case'].join('\n')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-40', '');
      const done = await app.get(PipelineService).step('plan', 'PROJ-40');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.mode).toBe('plan');
      expect(input.model).toBe('opus-5.5-extra-high');
      expect(input.timeLimitMs).toBe(20 * 60 * 1000);
      expect(input.mounts.map((mount) => mount.containerPath)).toEqual(['/work/billing-api']);
      expect(input.prompt).toContain('The only working directory is /work/billing-api (billing-api).');
      expect(input.prompt).toContain('Do not look outside it.');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const stored = await documents.find({ where: { kind: 'requirements' }, order: { id: 'DESC' } });
      expect(JSON.parse(stored[0]?.body ?? '{}').plan).toEqual({
        name: '',
        overview: '',
        items: ['add the field', 'cover the empty case'],
        decision: null,
      });
      const run = await app.get(HistoryService).findRun('PROJ-40');
      expect(run?.currentStep).toBe('plan-review');
      expect(run?.status).toBe('waiting');
      await app.get(PipelineService).step('plan', 'PROJ-40');
      expect(await documents.find({ where: { kind: 'requirements' } })).toHaveLength(stored.length);
      expect((await app.get(HistoryService).findRun('PROJ-40'))?.currentStep).toBe('plan-review');
    } finally {
      await app.close();
    }
  });

  it('continues the plan chat with a short prompt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-resume-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-45', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-45-plan-session.json'),
      `${JSON.stringify({ chatId: 'chat-1', resumed: true, completed: true, killReason: null, usd: 2 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(['plan:', '- add the field'].join('\n')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-45', '');
      const done = await app.get(PipelineService).step('plan', 'PROJ-45');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.resumeChatId).toBe('chat-1');
      expect(input.groupUsd).toBe(2);
      expect(input.prompt).toContain('The requirements in this message are the whole task');
      expect(input.prompt).not.toContain('# Plan');
      expect(input.prompt).not.toContain('ship the field');
      expect(input.prompt).not.toContain('What previous steps did');
    } finally {
      await app.close();
    }
  });

  it('mounts the stored project when the run is resumed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-stored-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-44', 'app'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(['plan:', '- add the field'].join('\n')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-44', '');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-44');
      if (!run) {
        throw new Error('run is missing');
      }
      run.projects = 'app\n';
      await history.saveRun(run);
      await history.putDocument(run, 'repos', 'app\n');
      const done = await app.get(PipelineService).step('plan', 'PROJ-44');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.mounts).toEqual([{ hostPath: join(root, 'worktrees', 'PROJ-44', 'app'), containerPath: '/work/app' }]);
    } finally {
      await app.close();
    }
  });

  it('does not start the agent while questions are open', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-questions-'));
    await writeEnv(root);
    const agent = jest.fn();
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-41', '- which field?\n');
      const result = await app.get(PipelineService).step('plan', 'PROJ-41');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('questions are open');
      expect(agent).not.toHaveBeenCalled();
      const run = await app.get(HistoryService).findRun('PROJ-41');
      expect(run?.currentStep).toBe('plan');
      expect(run?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('fails when the checklist is empty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-empty-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-42', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result('plan:\n- none\n'));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-42', '');
      const result = await app.get(PipelineService).step('plan', 'PROJ-42');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('plan is empty');
      expect((await app.get(HistoryService).findRun('PROJ-42'))?.currentStep).toBe('plan');
      expect((await app.get(HistoryService).findRun('PROJ-42'))?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });

  it('stops before the agent when the sandbox cannot start', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-sandbox-'));
    await writeEnv(root);
    const agent = jest.fn();
    const app = await boot(root, agent, new SwarmloopError('docker is not running'));
    try {
      await seed(app, 'PROJ-43', '');
      const result = await app.get(PipelineService).step('plan', 'PROJ-43');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('docker is not running');
      expect(agent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});

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

async function boot(root: string, agent: jest.Mock, sandboxError?: Error) {
  const assertReady = sandboxError ? jest.fn().mockRejectedValue(sandboxError) : jest.fn().mockResolvedValue(undefined);
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: agent })
    .overrideProvider(SandboxService)
    .useValue({ assertReady })
    .compile();
}

async function seed(app: Awaited<ReturnType<typeof boot>>, key: string, questions: string): Promise<void> {
  const history = app.get(HistoryService);
  const seeded = await history.begin(key, 'plan');
  seeded.status = 'waiting';
  seeded.currentStep = 'plan';
  await history.saveRun(seeded);
  await history.putDocument(seeded, 'requirements', '{"prompt":"ship the field"}\n');
  await history.putDocument(seeded, 'repos', 'billing-api\n');
  await history.putDocument(seeded, 'questions', questions);
}

async function writeEnv(root: string): Promise<void> {
  await writeFile(
    join(root, '.env'),
    [
      'RUNTIME=cursor',
      'REQUIREMENTS_VIA=direct',
      'ISSUE_TRACKER=jira',
      'JIRA_BASE_URL=',
      'JIRA_EMAIL=',
      'JIRA_API_TOKEN=',
      'GITLAB_BASE_URL=',
      'GITLAB_TOKEN=',
      'GITHUB_BASE_URL=',
      'GITHUB_TOKEN=',
      'CURSOR_API_KEY=',
      'ANTHROPIC_API_KEY=',
      'MAX_AGENT_CALLS=20',
      'MAX_RETURNS=3',
      'MAX_LAUNCHES=3',
      'MAX_RUN_USD=25',
      'IDLE_TIMEOUT_MS=900000',
      'TICK_MS=15000',
      'REQUIREMENTS_TIMEOUT_MS=600000',
      'RESEARCH_TIMEOUT_MS=900000',
      'PLAN_TIMEOUT_MS=1200000',
      'IMPLEMENT_TIMEOUT_MS=1800000',
      'CODE_REVIEW_TIMEOUT_MS=900000',
      'MERGE_REQUEST_TIMEOUT_MS=600000',
      'PIPELINE_TIMEOUT_MS=1800000',
      'PIPELINE_START_TIMEOUT_MS=180000',
      'MODEL_RESEARCH=grok-4.7',
      'MODEL_PLAN=opus-5.5-extra-high',
      'MODEL_IMPLEMENT=grok-4.7',
      'SWARMLOOP_API_PORT=3920',
      'SWARMLOOP_API_HOST=127.0.0.1',
      `SWARMLOOP_ROOT=${root}`,
      '',
    ].join('\n'),
  );
}
