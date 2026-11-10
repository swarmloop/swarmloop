import 'reflect-metadata';
import { RunStop } from '../../agent/run-stop';
import { StepKernel } from '../step-kernel';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { AppConfig } from '../../config/env';
import { StepEventLog } from '../../history/step-event.log';
import { Clock } from '../../core/clock';
import { runGit } from '../../git/git-repo.spec-helpers';
import { CheckoutRepository } from '../../history/checkout.repository';
import { DocumentRepository } from '../../history/document.repository';
import { FlowRepository } from '../../history/flow.repository';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { RebasedPublisher } from '../shared/rebased-publisher';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { expectGolden, recordingDocuments, traceRun } from '../../testing/step-trace.spec-helpers';
import { CommitStep } from './commit.step';

const KEY = 'PROJ-100';

describe('commit step golden traces', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-golden-'));
    app = await boot(root);
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  async function trace(name: string, tree: string, stub?: () => void) {
    await seed(app);
    stub?.();
    const documents = recordingDocuments(app.get(DocumentRepository));
    const step = new CommitStep(
      new StepKernel(
        app.get(RunRepository),
        documents,
        app.get(VisitRepository),
        app.get(FlowRepository),
        app.get(Clock),
        app.get(AppConfig),
        app.get(StepEventLog),
      ),
      app.get(CheckoutRepository),
      app.get(RebasedPublisher),
      new RunStop(),
    );
    const result = await step.execute(KEY);
    expectGolden(`commit.${name}`, {
      result: { exitCode: result.exitCode, message: result.message },
      ...(await traceRun(app.get(DataSource), KEY, { commit: documents.kinds })),
      git: {
        demo: {
          branch: runGit(tree, ['branch', '--show-current']).trim(),
          refs: runGit(tree, ['for-each-ref', '--format=%(refname) %(objectname)']).trim().split('\n'),
          log: runGit(tree, ['log', '--format=%s']).trim().split('\n'),
          status: runGit(tree, ['status', '--porcelain']).trim().split('\n').filter(Boolean),
        },
      },
    });
  }

  it('commits and pushes', async () => {
    const tree = featureTree(root);
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    await trace('ok', tree);
  });

  it('commits locally and skips CI when origin is missing', async () => {
    const tree = featureTree(root);
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    runGit(tree, ['remote', 'remove', 'origin']);
    await trace('no-origin', tree);
  });

  it('fails with a SwarmloopError when there is nothing to commit', async () => {
    await trace('swarmloop-error', featureTree(root));
  });

  it('fails with the generic text when a dependency throws a plain Error', async () => {
    const tree = featureTree(root);
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    await trace('plain-error', tree, () => {
      jest.spyOn(app.get(CheckoutRepository), 'listDenyPaths').mockRejectedValueOnce(new Error('disk gone'));
    });
  });
});

async function boot(root: string) {
  await writeFile(join(root, '.env'), envText(root));
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  }).compile();
}

async function seed(app: Awaited<ReturnType<typeof boot>>): Promise<void> {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(KEY, 'commit');
  seeded.status = 'waiting';
  seeded.currentStep = 'code-review';
  await runs.saveRun(seeded);
  await documents.putDocument(
    seeded,
    'requirements',
    `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [{ key: KEY, summary: 'Ship the field' }] })}\n`,
  );
  await documents.putDocument(seeded, 'repos', 'demo\n');
}

/** A clone with a bare origin and the run's feature worktree on its branch. */
function featureTree(root: string): string {
  const clone = join(root, 'demo');
  const remote = join(root, 'demo.git');
  const tree = join(root, 'worktrees', KEY, 'demo');
  runGit(root, ['init', '-q', '-b', 'main', clone]);
  runGit(clone, ['config', 'user.email', 'dev@example.com']);
  runGit(clone, ['config', 'user.name', 'Dev']);
  mkdirSync(join(clone, 'src'), { recursive: true });
  writeFileSync(join(clone, 'src', 'readme.ts'), 'export const readme = 1;\n');
  runGit(clone, ['add', 'src/readme.ts']);
  runGit(clone, ['commit', '-q', '-m', 'init']);
  runGit(root, ['init', '-q', '--bare', remote]);
  runGit(clone, ['remote', 'add', 'origin', remote]);
  runGit(clone, ['push', '-q', '-u', 'origin', 'main']);
  runGit(clone, ['switch', '-q', '-c', 'holder']);
  mkdirSync(join(tree, '..'), { recursive: true });
  runGit(clone, ['worktree', 'add', '-q', '-b', `feature/${KEY}-ship-the-field`, tree, 'main']);
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
    'MODEL_PLAN=opus-5.5-extra-high',
    'MODEL_IMPLEMENT=grok-4.7',
    'SWARMLOOP_API_PORT=3920',
    'SWARMLOOP_API_HOST=127.0.0.1',
    `SWARMLOOP_ROOT=${root}`,
    '',
  ].join('\n');
}
