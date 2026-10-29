import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Repository } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { DocumentEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER } from '../../limits/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { PASTE_READER } from '../../providers/tokens';

describe('branch step', () => {
  it('creates the feature branch only in the repos document', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-branch-'));
    const demo = repoWithMain(root, 'demo');
    const other = repoWithMain(root, 'other');
    const demoTree = addDetached(demo, join(root, 'worktrees', 'PROJ-30', 'demo'));
    const otherTree = addDetached(other, join(root, 'worktrees', 'PROJ-30', 'other'));
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-30', 'demo\n', 'Ship the field');
      const result = await app.get(PipelineService).step('branch', 'PROJ-30');
      expect(result.exitCode).toBe(0);
      expect(git(demoTree, ['branch', '--show-current'])).toBe('feature/PROJ-30-ship-the-field');
      expect(git(otherTree, ['branch', '--show-current'])).toBe('');
      expect(git(demo, ['branch', '--show-current'])).toBe('main');
      const run = await app.get(HistoryService).findRun('PROJ-30');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('keeps a branch that is already checked out', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-branch-again-'));
    const demo = repoWithMain(root, 'demo');
    const demoTree = addDetached(demo, join(root, 'worktrees', 'vendor-api', 'demo'));
    const app = await boot(root);
    try {
      await seed(app, 'vendor-api', 'demo\n', 'Add plot types');
      await app.get(PipelineService).step('branch', 'vendor-api');
      const again = await app.get(PipelineService).step('branch', 'vendor-api');
      expect(again.exitCode).toBe(0);
      expect(git(demoTree, ['branch', '--show-current'])).toBe('feature/vendor-api-add-plot-types');
      expect((await app.get(HistoryService).findRun('vendor-api'))?.currentStep).toBe('implement');
    } finally {
      await app.close();
    }
  });

  it('stops when a named repo has no worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-branch-missing-'));
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-31', 'missing\n', 'Ship the field');
      const result = await app.get(PipelineService).step('branch', 'PROJ-31');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('missing is not a worktree');
      const run = await app.get(HistoryService).findRun('PROJ-31');
      expect(run?.currentStep).toBe('branch');
      expect(run?.status).toBe('failed');
    } finally {
      await app.close();
    }
  });
});

async function boot(root: string): Promise<TestingModule> {
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
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(PASTE_READER)
    .useValue({ read: jest.fn() })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: jest.fn() })
    .compile();
}

async function seed(app: TestingModule, key: string, repos: string, summary: string): Promise<void> {
  const history = app.get(HistoryService);
  const seeded = await history.begin(key, 'branch');
  seeded.status = 'waiting';
  seeded.currentStep = 'branch';
  await history.saveRun(seeded);
  const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
  const row = (kind: string, body: string) =>
    documents.create({
      runId: seeded.id,
      stepStatId: 0,
      kind,
      attempt: 1,
      body,
      path: '',
      createdAt: new Date().toISOString(),
    });
  await documents.save(
    row(
      'requirements',
      `${JSON.stringify({
        prompt: `${summary}\n`,
        tickets: [{ key, summary, description: '', acceptanceCriteria: '', comments: [] }],
        epic: null,
        epics: [],
        files: [],
        pages: [],
      })}\n`,
    ),
  );
  await documents.save(row('repos', repos));
}

function addDetached(clone: string, worktree: string): string {
  mkdirSync(join(worktree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '--detach', worktree, 'origin/main']);
  return worktree;
}

function repoWithMain(root: string, dirName: string): string {
  const clone = join(root, dirName);
  const remote = join(root, `${dirName}.git`);
  git(root, ['init', '-b', 'main', clone]);
  writeFileSync(join(clone, 'README'), `${dirName}\n`);
  git(clone, ['add', 'README']);
  git(clone, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-m', dirName]);
  git(root, ['init', '--bare', remote]);
  git(clone, ['remote', 'add', 'origin', remote]);
  git(clone, ['push', '-u', 'origin', 'main']);
  return clone;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
