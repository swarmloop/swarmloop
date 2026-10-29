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
import { withPlan } from './plan-record';
import { PipelineService } from '../../pipeline/pipeline.service';
import { SandboxService } from '../../sandbox/sandbox.service';

const reply = ['plan:', '- add the field', '', 'decision: approve'].join('\n');

describe('plan-review step', () => {
  it('stores a second plan and waits before implementation when approved', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-review-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-50', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-50');
      const done = await app.get(PipelineService).step('plan-review', 'PROJ-50');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('plan-review done');
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.mode).toBe('plan');
      expect(input.model).toBe('opus-5.5-extra-high');
      expect(input.timeLimitMs).toBe(20 * 60 * 1000);
      expect(input.mounts.map((mount) => mount.containerPath)).toEqual(['/work/billing-api']);
      expect(input.prompt).toContain('add the field');
      expect(input.prompt).toContain('logical gaps');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const stored = await documents.find({ where: { kind: 'requirements' }, order: { id: 'DESC' } });
      expect(JSON.parse(stored[0]?.body ?? '{}').plan.decision).toBe('approve');
      const run = await app.get(HistoryService).findRun('PROJ-50');
      expect(run?.currentStep).toBe('branch');
      expect(run?.status).toBe('waiting');
      await app.get(PipelineService).step('plan-review', 'PROJ-50');
      expect(await documents.find({ where: { kind: 'requirements' } })).toHaveLength(stored.length);
      expect((await app.get(HistoryService).findRun('PROJ-50'))?.currentStep).toBe('branch');
    } finally {
      await app.close();
    }
  });

  it('stores a corrected checklist and advances to implementation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-review-fix-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-51', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result(['plan:', '- add the field', '- cover the empty case'].join('\n')));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-51');
      const done = await app.get(PipelineService).step('plan-review', 'PROJ-51');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('plan-review done');
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const stored = await documents.find({ where: { kind: 'requirements' }, order: { id: 'DESC' } });
      expect(JSON.parse(stored[0]?.body ?? '{}').plan).toEqual({
        name: '',
        overview: '',
        items: ['add the field', 'cover the empty case'],
        decision: 'approve',
      });
      const run = await app.get(HistoryService).findRun('PROJ-51');
      expect(run?.currentStep).toBe('branch');
      expect(run?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('keeps the given plan when the review returns no checklist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-review-keep-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-52', 'billing-api'), { recursive: true });
    const agent = jest.fn().mockResolvedValue(result('The checklist is already specific.'));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-52');
      const done = await app.get(PipelineService).step('plan-review', 'PROJ-52');
      expect(done.exitCode).toBe(0);
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      const stored = await documents.find({ where: { kind: 'requirements' }, order: { id: 'DESC' } });
      expect(JSON.parse(stored[0]?.body ?? '{}').plan.items).toEqual(['add the field']);
      const run = await app.get(HistoryService).findRun('PROJ-52');
      expect(run?.currentStep).toBe('branch');
    } finally {
      await app.close();
    }
  });

  it('resumes the plan chat with the follow-up', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-review-resume-'));
    await writeEnv(root);
    mkdirSync(join(root, 'worktrees', 'PROJ-53', 'billing-api'), { recursive: true });
    mkdirSync(join(root, 'data'), { recursive: true });
    writeFileSync(
      join(root, 'data', 'PROJ-53-plan-session.json'),
      `${JSON.stringify({ chatId: 'chat-1', resumed: true, completed: true, killReason: null, usd: 1 })}\n`,
    );
    const agent = jest.fn().mockResolvedValue(result(reply));
    const app = await boot(root, agent);
    try {
      await seed(app, 'PROJ-53');
      const done = await app.get(PipelineService).step('plan-review', 'PROJ-53');
      expect(done.exitCode).toBe(0);
      const input = agent.mock.calls[0]?.[0] as AgentRunInput;
      expect(input.resumeChatId).toBe('chat-1');
      expect(input.prompt).toContain('logical gaps');
      expect(input.prompt).not.toContain('# Plan review');
      expect(input.prompt).not.toContain('ship the field');
      expect(input.prompt).not.toContain('add the field');
      expect(input.prompt).not.toContain('What previous steps did');
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

async function boot(root: string, agent: jest.Mock) {
  const assertReady = jest.fn().mockResolvedValue(undefined);
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: agent })
    .overrideProvider(SandboxService)
    .useValue({ assertReady })
    .compile();
}

async function seed(app: Awaited<ReturnType<typeof boot>>, key: string): Promise<void> {
  const history = app.get(HistoryService);
  const seeded = await history.begin(key, 'plan-review');
  seeded.status = 'waiting';
  seeded.currentStep = 'plan-review';
  await history.saveRun(seeded);
  await history.putDocument(
    seeded,
    'requirements',
    withPlan('{"prompt":"ship the field"}\n', { name: '', overview: '', items: ['add the field'], decision: null }),
  );
  await history.putDocument(seeded, 'repos', 'billing-api\n');
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
