import { Test } from '@nestjs/testing';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { SwarmloopConfigModule } from '../../config/config.module';
import { writeEnvOverrides } from '../../testing/env.spec-helpers';
import { copyMainWithOrigin, git } from '../../testing/git-fixture';
import { seedMigratedDatabase } from '../../testing/migrated-database.spec-helpers';
import { AppConfig } from '../../config/env';
import { Clock } from '../../core/clock';
import { stampStored } from '../shared/gate.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { AgentRunResult } from '../../agent/agent-runner';
import { AGENT_RUNNER } from '../../agent/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { SandboxService } from '../../sandbox/sandbox.service';
import type { HttpCallDraft } from '../../core/swarmloop-error';

export const TOKEN = 'super-secret-token';

export function call(method: string, statusCode = 200): HttpCallDraft {
  return {
    provider: 'gitlab',
    method,
    url: 'https://gitlab.example/api/v4/projects/group%2Fdemo/merge_requests',
    statusCode,
    durationMs: 1,
    error: statusCode === 200 ? null : `HTTP ${statusCode}`,
  };
}

export function result(responseText: string): AgentRunResult {
  const now = new Date().toISOString();
  return {
    responseText,
    chatId: 'merge-request',
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

export async function boot(
  root: string,
  host: { find: jest.Mock; open: jest.Mock; update?: jest.Mock },
  agent: jest.Mock,
  token = TOKEN,
) {
  await writeEnvOverrides(root, {
    REQUIREMENTS_VIA: 'direct',
    GITLAB_BASE_URL: 'https://gitlab.example',
    GITLAB_TOKEN: token,
    GITHUB_BASE_URL: '',
    MAX_AGENT_CALLS: '20',
    MAX_RETURNS: '3',
    MAX_RUN_USD: '25',
    AGENTS_PLAN: 'cursor:opus-5.5-extra-high',
    AGENTS_IMPLEMENT: 'cursor:grok-4.7',
    AGENTS_REVIEW: 'cursor:opus-5.5-extra-high',
    SWARMLOOP_ROOT: root,
  });
  seedMigratedDatabase(root);
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(CodeHostRegistry)
    .useFactory({
      factory: (config: AppConfig, clock: Clock) => {
        const registry = CodeHostRegistry.create(config.env, clock);
        jest.spyOn(registry, 'byName').mockReturnValue({
          findMergeRequest: host.find,
          openMergeRequest: host.open,
          updateMergeRequest: host.update ?? jest.fn(async () => ({ httpCalls: [] })),
          readBranchPipeline: jest.fn(),
          readJobTrace: jest.fn(),
        } as never);
        return registry;
      },
      inject: [AppConfig, Clock],
    })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: agent })
    .overrideProvider(SandboxService)
    .useValue({ assertReady: jest.fn().mockResolvedValue(undefined) })
    .compile();
}

export async function seed(
  app: Awaited<ReturnType<typeof boot>>,
  key: string,
  options: { implementation?: boolean; repos?: string } = {},
): Promise<void> {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(key, 'merge-request');
  seeded.status = 'waiting';
  seeded.currentStep = 'commit';
  seeded.codeHost = 'gitlab';
  await runs.saveRun(seeded);
  await documents.putDocument(
    seeded,
    'requirements',
    `${JSON.stringify({
      prompt: 'Ship the field\n',
      tickets: [{ key, summary: 'Ship the field', description: '', acceptanceCriteria: '', comments: [] }],
      epic: null,
      epics: [],
      files: [],
      pages: [],
    })}\n`,
  );
  await documents.putDocument(seeded, 'repos', options.repos ?? 'demo\n');
  await documents.putDocument(seeded, 'pipeline_log', 'result: pass\n');
  if (options.implementation !== false) {
    await documents.putDocument(seeded, 'implementation', 'changed the field\n');
    await documents.putDocument(seeded, 'review_report', 'Ships the field.\n');
    await stampStored(app, seeded, 'review_report', (options.repos ?? 'demo\n').trim().split('\n'));
  }
}

/** A pushed feature branch with one commit its target does not have, or with none when `ahead` is false. */
export function featureTree(root: string, key: string, repo = 'demo', pushed = true, ahead = true): string {
  const { clone } = copyMainWithOrigin(root, repo);
  const tree = join(root, 'worktrees', key, repo);
  const branch = `feature/${key}-ship-the-field`;
  git(clone, ['remote', 'set-head', 'origin', 'main']);
  mkdirSync(join(tree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '-b', branch, tree, 'main']);
  if (ahead) {
    writeFileSync(join(tree, 'src', 'feature.ts'), 'export const feature = 1;\n');
    git(tree, ['add', 'src/feature.ts']);
    git(tree, ['commit', '-m', 'Ship the field']);
  }
  if (pushed) {
    git(tree, ['push', '-u', 'origin', branch]);
  }
  git(tree, ['remote', 'set-url', 'origin', `git@gitlab.example:group/${repo}.git`]);
  return tree;
}
