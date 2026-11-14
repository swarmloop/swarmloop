import { Test } from '@nestjs/testing';
import { mkdirSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopConfigModule } from '../../config/config.module';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { AgentRunInput, AgentRunResult } from '../../agent/agent-runner';
import { AGENT_RUNNER } from '../../agent/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { SandboxService } from '../../sandbox/sandbox.service';
import { withPlan } from '../plan/plan-record';

export function result(responseText: string): AgentRunResult {
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

export async function boot(root: string, agent: jest.Mock) {
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

export const storedTasks = [
  { id: 'column', title: 'Add the column', description: 'Adds it.', depends: [], files: ['a.ts'], proof: 'a.spec.ts' },
  { id: 'api', title: 'Send it', description: 'Sends it.', depends: ['column'], files: ['b.ts'], proof: 'b.spec.ts' },
].map((task) => ({ ...task, status: 'pending' }));

export async function seed(app: Awaited<ReturnType<typeof boot>>, key: string): Promise<void> {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(key, 'plan-improve');
  seeded.status = 'waiting';
  seeded.currentStep = 'plan-improve';
  await runs.saveRun(seeded);
  await documents.putDocument(
    seeded,
    'requirements',
    withPlan('{"prompt":"ship the field"}\n', { name: '', overview: '', items: ['add the field'], decision: null }),
  );
  await documents.putDocument(seeded, 'repos', 'billing-api\n');
}

export async function writeEnv(root: string): Promise<void> {
  await writeFile(
    join(root, '.env'),
    [
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
      'AGENTS_PLAN=cursor:opus-5.5-extra-high',
      'AGENTS_IMPLEMENT=cursor:grok-4.7',
      'AGENTS_REVIEW=cursor:opus-5.5-extra-high',
      'EPIC_EFFORT=',
      'SWARMLOOP_API_PORT=3920',
      'SWARMLOOP_API_HOST=127.0.0.1',
      `SWARMLOOP_ROOT=${root}`,
      '',
    ].join('\n'),
  );
}

/** Runs plan-improve on a split run that holds the stored tasks, answering with these results in order. */
export async function improveSplit(
  key: string,
  answers: string[],
  options: { split?: boolean; tasks?: boolean; stored?: unknown[]; keep?: string } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-improve-split-'));
  await writeEnv(root);
  mkdirSync(join(root, 'worktrees', key, 'billing-api'), { recursive: true });
  const agent = jest.fn();
  for (const answer of answers) agent.mockResolvedValueOnce(result(answer));
  const app = await boot(root, agent);
  try {
    await seed(app, key);
    const runs = app.get(RunRepository);
    const run = (await runs.findRun(key))!;
    await runs.saveRun({ ...run, split: options.split ?? true });
    const documents = app.get(DocumentRepository);
    if (options.tasks ?? true) {
      await documents.putDocument(run, 'subtasks', `${JSON.stringify(options.stored ?? storedTasks)}\n`);
      await documents.putDocument(run, 'contract', '- the column is called `split`\n');
      if (options.keep) await documents.putDocument(run, 'keep', options.keep);
    }
    const done = await app.get(PipelineService).step('plan-improve', key);
    return {
      done,
      prompts: agent.mock.calls.map((call) => (call[0] as AgentRunInput).prompt),
      run: await runs.findRun(key),
      subtasks: await documents.latestBody(key, 'subtasks'),
      requirements: await documents.latestBody(key, 'requirements'),
    };
  } finally {
    await app.close();
  }
}
