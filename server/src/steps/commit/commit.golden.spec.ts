import 'reflect-metadata';
import { RunStop } from '../../agent/run-stop';
import { StepKernel } from '../step-kernel';
import { writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { writeEnvOverrides } from '../../testing/env.spec-helpers';
import { AppConfig } from '../../config/env';
import { StepEventLog } from '../../history/step-event.log';
import { Clock } from '../../core/clock';
import { runGit } from '../../git/git-repo.spec-helpers';
import { DocumentRepository } from '../../history/document.repository';
import { FlowRepository } from '../../history/flow.repository';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { RunNames } from '../shared/run-names';
import { RebasedPublisher } from '../shared/rebased-publisher';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { seedMigratedDatabase } from '../../testing/migrated-database.spec-helpers';
import { featureWorktree } from '../../testing/runs.spec-helpers';
import { expectGolden, recordingDocuments, traceRun } from '../../testing/step-trace.spec-helpers';
import { RunAuthor } from '../shared/run-author';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
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

  async function trace(name: string, tree: string, stub?: () => void | Promise<void>) {
    await seed(app);
    await stub?.();
    const documents = recordingDocuments(app.get(DocumentRepository));
    const kernel = new StepKernel(
      app.get(RunRepository),
      documents,
      app.get(VisitRepository),
      app.get(FlowRepository),
      app.get(Clock),
      app.get(AppConfig),
      app.get(StepEventLog),
    );
    const step = new CommitStep(
      kernel,
      app.get(RebasedPublisher),
      app.get(RunNames),
      app.get(RunAuthor),
      app.get(CodeHostRegistry),
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
    const tree = featureWorktree(root, KEY).tree;
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    await trace('ok', tree);
  });

  it('commits locally and skips CI when origin is missing', async () => {
    const tree = featureWorktree(root, KEY).tree;
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    runGit(tree, ['remote', 'remove', 'origin']);
    await trace('no-origin', tree);
  });

  it('fails with a SwarmloopError when a re-run of CI cannot be pushed', async () => {
    const tree = featureWorktree(root, KEY).tree;
    runGit(tree, ['push', '-q', '-u', 'origin', `feature/${KEY}-ship-the-field`]);
    runGit(tree, ['remote', 'set-url', 'origin', join(root, 'gone.git')]);
    await trace('swarmloop-error', tree, async () => {
      const run = (await app.get(RunRepository).findRun(KEY))!;
      await app.get(DocumentRepository).putDocument(run, 'ci_rerun', 'demo old -> new\n');
    });
  });

  it('fails with the generic text when a dependency throws a plain Error', async () => {
    const tree = featureWorktree(root, KEY).tree;
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    await trace('plain-error', tree, () => {
      jest.spyOn(app.get(FlowRepository), 'activePhases').mockRejectedValueOnce(new Error('disk gone'));
    });
  });
});

async function boot(root: string) {
  await writeEnvOverrides(root, envOverrides(root));
  seedMigratedDatabase(root);
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

function envOverrides(root: string): Record<string, string> {
  return {
    REQUIREMENTS_VIA: 'direct',
    GITLAB_BASE_URL: '',
    GITHUB_BASE_URL: '',
    MAX_AGENT_CALLS: '20',
    MAX_RETURNS: '3',
    MAX_RUN_USD: '25',
    AGENTS_PLAN: 'cursor:opus-5.5-extra-high',
    AGENTS_IMPLEMENT: 'cursor:grok-4.7',
    AGENTS_REVIEW: 'cursor:opus-5.5-extra-high',
    SWARMLOOP_ROOT: root,
  };
}
