import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { EnvironmentService } from '../environment/environment.service';
import { mkdirSync } from 'fs';
import { copyMainWithOrigin, git } from './git-fixture';
import { join } from 'path';
import { writeEnvOverrides } from './env.spec-helpers';
import { SwarmloopConfigModule } from '../config/config.module';
import { AuthModule } from '../auth/auth.module';
import { HistoryModule } from '../history/history.module';
import { AppConfig } from '../config/env';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { LiveModule } from '../live/live.module';
import type { VisitDraft } from '../history/visit';
import { CommandService } from '../pipeline/command.service';
import { StartGate } from '../pipeline/start-gate';
import { RunGuards } from '../pipeline/run-guards';
import { SubtaskPort } from '../pipeline/subtask-port';
import { AgentDoor } from '../steps/shared/agent-door';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { SpendLimit } from '../steps/shared/spend-limit';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { RunStop } from '../agent/run-stop';
import { PipelineService } from '../pipeline/pipeline.service';
import { writeRunState } from '../history/run-state';
import { QuestionHolds } from '../steps/shared/question-holds';
import { QuestionPassOn } from '../pipeline/question-pass-on';
import { RunStateRefresh } from '../steps/shared/run-state-refresh';
import { StepRegistry } from '../steps/step.registry';
import { PrepareStep } from '../steps/prepare/prepare.step';
import { ProjectAppendService } from '../steps/prepare/project-append.service';
import { ISSUE_TRACKER } from '../integrations/issue-tracker/tokens';
import { SubtaskClose } from '../api/subtask-close';
import { RunAnswersService } from '../api/run-answers.service';
import { RunCommandsService } from '../api/run-commands.service';
import { RunSubtaskCommandsService } from '../api/run-subtask-commands.service';
import { RunQueriesService } from '../api/run-queries.service';
import { RunListRows } from '../api/run-list-rows';
import { EtaSummary } from '../api/eta-summary';
import { RunReport } from '../steps/shared/run-report';
import { RunRebaseService } from '../api/run-rebase.service';
import { WorkspaceGuard } from '../pipeline/workspace-guard';
import { RunAuthor } from '../steps/shared/run-author';
import { RebasedPublisher } from '../steps/shared/rebased-publisher';
import { RunRebase, RunRebaseEnvironment } from '../steps/run-rebase';
import { RunNames } from '../steps/shared/run-names';
import { MergeRequestDrafts } from '../steps/merge-request/merge-request-draft';

export { git };

const agent = { runtime: 'claude', model: 'opus', mode: 'agent', timeLimitMs: 1000, session: 'fresh' as const };
const descriptors = [
  { name: 'implement', kind: 'agent', agent },
  { name: 'code-review', kind: 'agent', agent, reviewers: [{ name: 'quality', model: 'opus', mode: 'agent' }] },
  { name: 'commit', kind: 'server' },
];

export async function boot(
  root: string,
  pipeline: { startDetached: jest.Mock; stop?: jest.Mock; replay?: jest.Mock; claimed?: (key: string) => boolean } = {
    startDetached: jest.fn(),
  },
  prepare: { removeWorktrees: jest.Mock } = { removeWorktrees: jest.fn().mockResolvedValue(undefined) },
  env: Record<string, string> = {},
) {
  await writeEnvOverrides(root, {
    GITLAB_BASE_URL: 'https://gitlab.example',
    GITLAB_TOKEN: 'token',
    SWARMLOOP_ROOT: root,
    ...env,
  });
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), HistoryModule, LiveModule, AuthModule],
    providers: [
      RunQueriesService,
      RunStateRefresh,
      QuestionHolds,
      QuestionPassOn,
      RunListRows,
      EtaSummary,
      RunReport,
      RunCommandsService,
      RunAnswersService,
      RunSubtaskCommandsService,
      SubtaskClose,
      CommandService,
      StartGate,
      AgentDoor,
      SpendLimit,
      {
        provide: RunGuards,
        useFactory: (runs: RunRepository, documents: DocumentRepository, limit: SpendLimit) =>
          new RunGuards(runs, documents, limit, {} as never, {} as never),
        inject: [RunRepository, DocumentRepository, SpendLimit],
      },
      SubtaskPort,
      { provide: AgentLauncher, useValue: {} },
      { provide: CodeHostRegistry, useValue: { tokensFor: () => Promise.resolve({}) } },
      RunStop,
      RunRebaseService,
      RunRebase,
      {
        provide: RunNames,
        useFactory: (documents: DocumentRepository, config: AppConfig, runs: RunRepository) =>
          new RunNames({ documents, config, runs } as never),
        inject: [DocumentRepository, AppConfig, RunRepository],
      },
      { provide: RunAuthor, useValue: { of: async () => null } },
      { provide: RebasedPublisher, useValue: { publishRebased: async () => undefined } },
      MergeRequestDrafts,
      { provide: WorkspaceGuard, useValue: { ensureForRequest: async () => undefined } },
      { provide: RunRebaseEnvironment, useExisting: EnvironmentService },
      { provide: EnvironmentService, useValue: { refreshAfterRebase: jest.fn().mockResolvedValue(undefined) } },
      { provide: PipelineService, useValue: { claimed: () => false, ...pipeline } },
      {
        provide: StepRegistry,
        useValue: {
          describe: () => descriptors,
          get: (name: string) => (name === 'implement' ? { usesModel: true } : null),
        },
      },
      { provide: ProjectAppendService, useValue: { add: jest.fn(), flush: jest.fn() } },
      { provide: PrepareStep, useValue: prepare },
      {
        provide: ISSUE_TRACKER,
        useValue: { fetch: jest.fn(), ticketKeys: async (text: string) => text.match(/PROJ-\d+/g) ?? [] },
      },
    ],
  }).compile();
}

export function visit(step: string, status: string): VisitDraft {
  const now = new Date().toISOString();
  return {
    step,
    model: null,
    mode: null,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    status,
    exitCode: 0,
    killReason: null,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    samples: [],
    exchange: null,
    httpCalls: [],
    document: null,
    resumed: false,
  };
}

export async function remember(
  runs: RunRepository,
  documents: DocumentRepository,
  key: string,
  step: string,
  status: string,
) {
  const run = await save(runs, key, step, status);
  await documents.putDocument(
    run,
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
  await documents.putDocument(run, 'repos', 'demo\n');
  return run;
}

export function featureWorktree(root: string, key: string, repo = 'demo'): { tree: string; clone: string } {
  const { clone } = copyMainWithOrigin(root, repo);
  const tree = join(root, 'worktrees', key, repo);
  mkdirSync(join(tree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '-b', `feature/${key}-ship-the-field`, tree, 'main']);
  return { tree, clone };
}

export function isAncestor(cwd: string, base: string): boolean {
  try {
    git(cwd, ['merge-base', '--is-ancestor', base, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export function hostFetch(bare: string, token: string): () => void {
  const entries = [
    ['protocol.file.allow', 'always'],
    [`url.${bare}.insteadOf`, `https://oauth2:${token}@gitlab.example/group/demo.git`],
  ];
  const start = Number(process.env.GIT_CONFIG_COUNT);
  const base = Number.isInteger(start) && start > 0 ? start : 0;
  const savedCount = process.env.GIT_CONFIG_COUNT;
  const saved = entries.map((_, index) => {
    const slot = String(base + index);
    return { slot, key: process.env[`GIT_CONFIG_KEY_${slot}`], value: process.env[`GIT_CONFIG_VALUE_${slot}`] };
  });
  entries.forEach(([key, value], index) => {
    const slot = String(base + index);
    process.env[`GIT_CONFIG_KEY_${slot}`] = key;
    process.env[`GIT_CONFIG_VALUE_${slot}`] = value;
  });
  process.env.GIT_CONFIG_COUNT = String(base + entries.length);
  return () => {
    if (savedCount === undefined) {
      delete process.env.GIT_CONFIG_COUNT;
    } else {
      process.env.GIT_CONFIG_COUNT = savedCount;
    }
    for (const item of saved) {
      if (item.key === undefined) {
        delete process.env[`GIT_CONFIG_KEY_${item.slot}`];
      } else {
        process.env[`GIT_CONFIG_KEY_${item.slot}`] = item.key;
      }
      if (item.value === undefined) {
        delete process.env[`GIT_CONFIG_VALUE_${item.slot}`];
      } else {
        process.env[`GIT_CONFIG_VALUE_${item.slot}`] = item.value;
      }
    }
  };
}

export async function save(runs: RunRepository, key: string, step: string, status: string, attemptsReview = 0) {
  const run = await runs.begin(key, step);
  writeRunState(run, { status, currentStep: step });
  run.attemptsReview = attemptsReview;
  if (status === 'running' && step === 'code-review') {
    // A log counts for the open round only when its file is newer than the round start. The kernel dates files with a coarser clock than the one that dated the claim, so a log written right after it can look older. The round began a minute ago.
    run.stepStartedAt = new Date(Date.now() - 60_000).toISOString();
  }
  return runs.saveRun(run);
}
