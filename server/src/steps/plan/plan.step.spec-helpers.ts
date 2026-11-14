import { Test } from '@nestjs/testing';
import { join } from 'path';
import { SwarmloopConfigModule } from '../../config/config.module';
import { writeEnvOverrides } from '../../testing/env.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { AgentRunResult } from '../../agent/agent-runner';
import { AGENT_RUNNER } from '../../agent/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { SandboxService } from '../../sandbox/sandbox.service';

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
