import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { Test } from '@nestjs/testing';
import { EnvironmentService } from '../environment/environment.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import type { Repository } from 'typeorm';
import { DenyPathEntity } from '../history/entities';
import { SwarmloopConfigModule } from '../config/config.module';
import { AuthModule } from '../auth/auth.module';
import { HistoryModule } from '../history/history.module';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import { LiveModule } from '../live/live.module';
import type { VisitDraft } from '../history/visit';
import { CommandService } from '../pipeline/command.service';
import { SubtaskPort } from '../pipeline/subtask-port';
import { AgentLauncher } from '../steps/shared/agent-launcher';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { RunStop } from '../agent/run-stop';
import { PipelineService } from '../pipeline/pipeline.service';
import { writeRunState } from '../history/run-state';
import { StepRegistry } from '../steps/step.registry';
import { PrepareStep } from '../steps/prepare/prepare.step';
import { ProjectAppendService } from '../steps/prepare/project-append.service';
import { ISSUE_TRACKER } from '../integrations/issue-tracker/tokens';
import { SubtaskClose } from '../api/subtask-close';
import { RunCommandsService } from '../api/run-commands.service';
import { RunSubtaskCommandsService } from '../api/run-subtask-commands.service';
import { RunQueriesService } from '../api/run-queries.service';
import { RunRebaseService } from '../api/run-rebase.service';
import { WorkspaceGuard } from '../pipeline/workspace-guard';
import { RunRebase, RunRebaseEnvironment } from '../steps/run-rebase';
import { MergeRequestDrafts } from '../steps/merge-request/merge-request-draft';

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
) {
  await writeFile(
    join(root, '.env'),
    [
      'REQUIREMENTS_VIA=direct',
      'ISSUE_TRACKER=jira',
      'JIRA_BASE_URL=',
      'JIRA_EMAIL=',
      'JIRA_API_TOKEN=',
      'GITLAB_BASE_URL=https://gitlab.example',
      'GITLAB_TOKEN=token',
      'GITHUB_BASE_URL=',
      'GITHUB_TOKEN=',
      'CURSOR_API_KEY=test-cursor-key',
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
      'SWARMLOOP_API_PORT=3920',
      'SWARMLOOP_API_HOST=127.0.0.1',
      `SWARMLOOP_ROOT=${root}`,
    ].join('\n'),
  );
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), HistoryModule, LiveModule, AuthModule],
    providers: [
      RunQueriesService,
      RunCommandsService,
      RunSubtaskCommandsService,
      SubtaskClose,
      CommandService,
      SubtaskPort,
      { provide: AgentLauncher, useValue: {} },
      { provide: CodeHostRegistry, useValue: { tokensFor: () => Promise.resolve({}) } },
      RunStop,
      RunRebaseService,
      RunRebase,
      MergeRequestDrafts,
      { provide: WorkspaceGuard, useValue: { ensureForRequest: async () => undefined } },
      { provide: RunRebaseEnvironment, useExisting: EnvironmentService },
      { provide: EnvironmentService, useValue: { refreshAfterRebase: jest.fn().mockResolvedValue(undefined) } },
      { provide: PipelineService, useValue: { claimed: () => false, ...pipeline } },
      { provide: StepRegistry, useValue: { describe: () => descriptors } },
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
  const clone = join(root, repo);
  const remote = join(root, `${repo}.git`);
  const tree = join(root, 'worktrees', key, repo);
  git(root, ['init', '-b', 'main', clone]);
  git(clone, ['config', 'user.email', 'dev@example.com']);
  git(clone, ['config', 'user.name', 'Dev']);
  mkdirSync(join(clone, 'src'), { recursive: true });
  writeFileSync(join(clone, 'src', 'readme.ts'), 'export const readme = 1;\n');
  git(clone, ['add', 'src/readme.ts']);
  git(clone, ['commit', '-m', 'init']);
  git(root, ['init', '--bare', remote]);
  git(clone, ['remote', 'add', 'origin', remote]);
  git(clone, ['push', '-u', 'origin', 'main']);
  git(clone, ['switch', '-c', 'holder']);
  mkdirSync(join(tree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '-b', `feature/${key}-ship-the-field`, tree, 'main']);
  return { tree, clone };
}

export async function denyEnv(app: Awaited<ReturnType<typeof boot>>): Promise<void> {
  const deny = app.get<Repository<DenyPathEntity>>(getRepositoryToken(DenyPathEntity));
  await deny.save(deny.create({ pattern: '.env' }));
}

export function isAncestor(cwd: string, base: string): boolean {
  try {
    git(cwd, ['merge-base', '--is-ancestor', base, 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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
  return runs.saveRun(run);
}
