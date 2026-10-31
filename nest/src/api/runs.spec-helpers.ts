import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, writeFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';
import { Repository } from 'typeorm';
import { DenyPathEntity } from '../history/entities';
import { SwarmloopConfigModule } from '../config/config.module';
import { HistoryModule } from '../history/history.module';
import { HistoryService } from '../history/history.service';
import { LiveModule } from '../live/live.module';
import { VisitDraft } from '../history/visit';
import { PipelineService } from '../pipeline/pipeline.service';
import { PrepareService } from '../steps/prepare/prepare.service';
import { ProjectAppendService } from '../steps/prepare/project-append.service';
import { RunsService } from './runs.service';

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
      'RUNTIME=cursor',
      'REQUIREMENTS_VIA=direct',
      'ISSUE_TRACKER=jira',
      'JIRA_BASE_URL=',
      'JIRA_EMAIL=',
      'JIRA_API_TOKEN=',
      'GITLAB_BASE_URL=https://gitlab.example',
      'GITLAB_TOKEN=token',
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
    ].join('\n'),
  );
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), HistoryModule, LiveModule],
    providers: [
      RunsService,
      { provide: PipelineService, useValue: { claimed: () => false, ...pipeline } },
      { provide: ProjectAppendService, useValue: { add: jest.fn(), flush: jest.fn() } },
      { provide: PrepareService, useValue: prepare },
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

export async function remember(history: HistoryService, key: string, step: string, status: string) {
  const run = await save(history, key, step, status);
  await history.putDocument(
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
  await history.putDocument(run, 'repos', 'demo\n');
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

export async function save(history: HistoryService, key: string, step: string, status: string, attemptsReview = 0) {
  const run = await history.begin(key, step);
  run.status = status;
  run.currentStep = step;
  run.ownerPid = null;
  run.attemptsReview = attemptsReview;
  return history.saveRun(run);
}
