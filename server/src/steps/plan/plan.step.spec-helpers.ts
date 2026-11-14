import { Test } from '@nestjs/testing';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopConfigModule } from '../../config/config.module';
import { writeEnvOverrides } from '../../testing/env.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { AgentRunInput, AgentRunResult } from '../../agent/agent-runner';
import { PipelineService } from '../../pipeline/pipeline.service';
import { AGENT_RUNNER } from '../../agent/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { SandboxService } from '../../sandbox/sandbox.service';
import { resultAnswer } from '../../testing/result-answer';

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

/** The final answer of a plan that holds a checklist. */
export function planBlock(items: string[], extra: Record<string, unknown> = {}): string {
  return resultAnswer('Done.', { summary: ['why'], plan: items, ...extra });
}

/** The final answer of a plan that stops on questions. */
export function questionsBlock(questions: string[]): string {
  return resultAnswer('Done.', { summary: ['stopped'], questions });
}

export async function boot(root: string, agent: jest.Mock, sandboxError?: Error) {
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

export async function seed(app: Awaited<ReturnType<typeof boot>>, key: string, questions: string): Promise<void> {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(key, 'plan');
  seeded.status = 'waiting';
  seeded.currentStep = 'plan';
  await runs.saveRun(seeded);
  await documents.putDocument(seeded, 'requirements', '{"prompt":"ship the field"}\n');
  await documents.putDocument(seeded, 'repos', 'billing-api\n');
  await documents.putDocument(seeded, 'questions', questions);
}

export async function writeEnv(root: string, planTimeout = 1200000): Promise<void> {
  await writeEnvOverrides(root, {
    REQUIREMENTS_VIA: 'direct',
    GITLAB_BASE_URL: '',
    GITHUB_BASE_URL: '',
    CURSOR_API_KEY: 'test-key',
    MAX_AGENT_CALLS: '20',
    MAX_RETURNS: '3',
    MAX_RUN_USD: '25',
    PLAN_TIMEOUT_MS: String(planTimeout),
    AGENTS_PLAN: 'cursor:opus-5.5-extra-high',
    AGENTS_IMPLEMENT: 'cursor:grok-4.7',
    AGENTS_REVIEW: 'cursor:opus-5.5-extra-high',
    SWARMLOOP_ROOT: root,
  });
}

export function writeChat(root: string, key: string, runtime = 'cursor'): void {
  mkdirSync(join(root, 'data', 'agent-state', key, 'plan'), { recursive: true });
  writeFileSync(
    join(root, 'data', `${key}-plan-session.json`),
    `${JSON.stringify({ runtime, chatId: 'chat-1', resumed: true, completed: true, killReason: null, usd: 0 })}\n`,
  );
}

export const RULES = (chatRuntime: string) => ({ text: 'Keep it small.\n', chatRuntime });

export interface SplitOptions {
  split?: boolean;
  subtask?: boolean;
  /** Leaves the chat research shares with the plan step. */
  chat?: boolean;
  runtime?: string;
  /** The plan agent is Claude, the repository has this `AGENTS.md`, and the stored chat belongs to `chatRuntime`. */
  rules?: { text: string; chatRuntime: string };
}

export async function runSplit(key: string, answer: string, options: SplitOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-split-'));
  await writeEnv(root);
  if (options.runtime) {
    const env = join(root, '.env');
    writeFileSync(env, readFileSync(env, 'utf8').replaceAll('=cursor:', `=${options.runtime}:`));
  }
  mkdirSync(join(root, 'worktrees', key, 'billing-api'), { recursive: true });
  if (options.rules) {
    writeFileSync(join(root, 'worktrees', key, 'billing-api', 'AGENTS.md'), options.rules.text);
  }
  if (options.chat) {
    writeChat(root, key, options.rules?.chatRuntime);
  }
  const agent = jest.fn().mockResolvedValue(result(answer));
  const app = await boot(root, agent);
  try {
    const runs = app.get(RunRepository);
    await seed(app, key, '');
    const seeded = (await runs.findRun(key))!;
    const parent = options.subtask ? await runs.openWaiting(`${key}-parent`, '/target') : null;
    await runs.saveRun({
      ...seeded,
      split: options.split ?? true,
      ...(options.rules ? { agents: { main: { plan: [{ runtime: 'claude', model: 'm-claude' }] } } } : {}),
      ...(parent ? { parentRunId: parent.id, taskId: 't1' } : {}),
    });
    const done = await app.get(PipelineService).step('plan', key);
    const documents = app.get(DocumentRepository);
    return {
      done,
      input: agent.mock.calls[0]?.[0] as AgentRunInput,
      run: await runs.findRun(key),
      subtasks: await documents.latestBody(key, 'subtasks'),
      contract: await documents.latestBody(key, 'contract'),
      requirements: await documents.latestBody(key, 'requirements'),
    };
  } finally {
    await app.close();
  }
}
