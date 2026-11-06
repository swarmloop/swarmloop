import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { AppConfig } from '../../config/env';
import { Clock } from '../../core/clock';
import { runGit } from '../../git/git-repo.spec-helpers';
import { DocumentRepository } from '../../history/document.repository';
import { FlowRepository } from '../../history/flow.repository';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { expectGolden, recordingDocuments, traceRun } from '../../testing/step-trace.spec-helpers';
import { BranchStep } from './branch.step';

const KEY = 'PROJ-30';
const BRANCH = `feature/${KEY}-ship-the-field`;

describe('branch step golden traces', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-branch-golden-'));
    app = await boot(root);
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  async function trace(name: string, trees: Record<string, string>, stub?: () => void) {
    await seed(app, trees);
    stub?.();
    const documents = recordingDocuments(app.get(DocumentRepository));
    const step = new BranchStep(
      app.get(RunRepository),
      documents,
      app.get(VisitRepository),
      app.get(FlowRepository),
      app.get(Clock),
      app.get(AppConfig),
    );
    const result = await step.execute(KEY);
    const git = Object.fromEntries(
      Object.entries(trees).map(([repo, tree]) => [
        repo,
        {
          branch: runGit(tree, ['branch', '--show-current']).trim(),
          refs: runGit(tree, ['for-each-ref', '--format=%(refname) %(objectname)']).trim().split('\n'),
          log: runGit(tree, ['log', '--format=%s']).trim().split('\n'),
        },
      ]),
    );
    expectGolden(`branch.${name}`, {
      result: { exitCode: result.exitCode, message: result.message },
      ...(await traceRun(app.get(DataSource), KEY, { branch: documents.kinds })),
      git,
    });
  }

  it('creates the feature branch', async () => {
    await trace('ok', { demo: worktree(root, 'demo') });
  });

  it('keeps the commits of an earlier branch under refs/swarmloop/earlier', async () => {
    const tree = worktree(root, 'demo');
    runGit(tree, ['switch', '-c', BRANCH]);
    writeFileSync(join(tree, 'WORK'), 'WORK\n');
    runGit(tree, ['add', 'WORK']);
    runGit(tree, ['commit', '-q', '-m', 'WORK']);
    runGit(tree, ['switch', '--detach', 'origin/main']);
    await trace('earlier-branch-kept', { demo: tree });
  });

  it('fails with a SwarmloopError when a repo has no worktree', async () => {
    await trace('swarmloop-error', {});
  });

  it('fails with the generic text when a dependency throws a plain Error', async () => {
    const tree = worktree(root, 'demo');
    await trace('plain-error', { demo: tree }, () => {
      jest.spyOn(app.get(DocumentRepository), 'latestBody').mockRejectedValueOnce(new Error('disk gone'));
    });
  });
});

async function boot(root: string) {
  await writeFile(join(root, '.env'), envText(root));
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  }).compile();
}

async function seed(app: Awaited<ReturnType<typeof boot>>, trees: Record<string, string>): Promise<void> {
  const seeded = await app.get(RunRepository).begin(KEY, 'branch');
  seeded.status = 'waiting';
  seeded.currentStep = 'branch';
  await app.get(RunRepository).saveRun(seeded);
  const documents = app.get(DocumentRepository);
  await documents.putDocument(
    seeded,
    'requirements',
    `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [{ key: KEY, summary: 'Ship the field' }] })}\n`,
  );
  await documents.putDocument(
    seeded,
    'repos',
    Object.keys(trees).length ? `${Object.keys(trees).join('\n')}\n` : 'missing\n',
  );
}

/** A clone with a bare origin and a detached worktree for the run, as the prepare step leaves it. */
function worktree(root: string, name: string): string {
  const clone = join(root, name);
  const remote = join(root, `${name}.git`);
  const tree = join(root, 'worktrees', KEY, name);
  runGit(root, ['init', '-q', '-b', 'main', clone]);
  writeFileSync(join(clone, 'README'), `${name}\n`);
  runGit(clone, ['add', 'README']);
  runGit(clone, ['commit', '-q', '-m', name]);
  runGit(root, ['init', '-q', '--bare', remote]);
  runGit(clone, ['remote', 'add', 'origin', remote]);
  runGit(clone, ['push', '-q', '-u', 'origin', 'main']);
  mkdirSync(join(tree, '..'), { recursive: true });
  runGit(clone, ['worktree', 'add', '-q', '--detach', tree, 'origin/main']);
  return tree;
}

function envText(root: string): string {
  return [
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
  ].join('\n');
}
