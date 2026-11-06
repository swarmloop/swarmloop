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
import type { HttpCallDraft } from '../../core/swarmloop-error';
import { runGit } from '../../git/git-repo.spec-helpers';
import { DocumentRepository } from '../../history/document.repository';
import { FlowRepository } from '../../history/flow.repository';
import { RunRepository } from '../../history/run.repository';
import { VisitRepository } from '../../history/visit.repository';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { expectGolden, recordingDocuments, traceRun } from '../../testing/step-trace.spec-helpers';
import { MergeRequestStep } from './merge-request.step';

const KEY = 'PROJ-200';
const MR_URL = 'https://gitlab.example/group/demo/-/merge_requests/12';

function call(method: string): HttpCallDraft {
  return {
    provider: 'gitlab',
    method,
    url: 'https://gitlab.example/api/v4/projects/group%2Fdemo/merge_requests',
    statusCode: 200,
    durationMs: 1,
    error: null,
  };
}

describe('merge-request step golden traces', () => {
  let root: string;
  let app: Awaited<ReturnType<typeof boot>>;
  let host: Record<'findMergeRequest' | 'openMergeRequest' | 'updateMergeRequest', jest.Mock>;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-golden-'));
    app = await boot(root);
    host = { findMergeRequest: jest.fn(), openMergeRequest: jest.fn(), updateMergeRequest: jest.fn() };
    jest.spyOn(app.get(CodeHostRegistry), 'byName').mockReturnValue(host as never);
    host.findMergeRequest.mockResolvedValue({ record: null, httpCalls: [call('GET')] });
    host.openMergeRequest.mockResolvedValue({
      record: { project: 'group/demo', iid: 12, url: MR_URL, summary: '' },
      httpCalls: [call('POST')],
    });
    host.updateMergeRequest.mockResolvedValue({ httpCalls: [call('PUT')] });
  });

  afterEach(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  async function trace(name: string, options: { implementation?: boolean } = {}) {
    const tree = featureTree(root);
    await seed(app, options.implementation !== false);
    const documents = recordingDocuments(app.get(DocumentRepository));
    const step = new MergeRequestStep(
      app.get(RunRepository),
      documents,
      app.get(VisitRepository),
      app.get(FlowRepository),
      app.get(Clock),
      app.get(AppConfig),
      app.get(CodeHostRegistry),
    );
    const result = await step.execute(KEY);
    expectGolden(`merge-request.${name}`, {
      result: { exitCode: result.exitCode, message: result.message },
      ...(await traceRun(app.get(DataSource), KEY, { 'merge-request': documents.kinds })),
      hostCalls: {
        find: host.findMergeRequest.mock.calls,
        open: host.openMergeRequest.mock.calls,
        update: host.updateMergeRequest.mock.calls,
      },
      git: {
        demo: {
          branch: runGit(tree, ['branch', '--show-current']).trim(),
          refs: runGit(tree, ['for-each-ref', '--format=%(refname) %(objectname)']).trim().split('\n'),
          log: runGit(tree, ['log', '--format=%s']).trim().split('\n'),
        },
      },
    });
  }

  it('creates the merge request', async () => {
    await trace('created');
  });

  it('reuses an existing merge request and updates its description', async () => {
    host.findMergeRequest.mockResolvedValue({
      record: {
        project: 'group/demo',
        iid: 9,
        url: 'https://gitlab.example/group/demo/-/merge_requests/9',
        summary: 'Already open.',
      },
      httpCalls: [call('GET')],
    });
    await trace('reused');
  });

  it('fails with a SwarmloopError when the implementation is missing', async () => {
    await trace('swarmloop-error', { implementation: false });
  });

  it('fails with the generic text when the host client throws a plain Error', async () => {
    host.findMergeRequest.mockRejectedValue(new Error('socket hang up'));
    await trace('plain-error');
  });
});

async function boot(root: string) {
  await writeFile(join(root, '.env'), envText(root));
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  }).compile();
}

async function seed(app: Awaited<ReturnType<typeof boot>>, implementation: boolean): Promise<void> {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(KEY, 'merge-request');
  seeded.status = 'waiting';
  seeded.currentStep = 'commit';
  seeded.codeHost = 'gitlab';
  await runs.saveRun(seeded);
  await documents.putDocument(
    seeded,
    'requirements',
    `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [{ key: KEY, summary: 'Ship the field' }] })}\n`,
  );
  await documents.putDocument(seeded, 'repos', 'demo\n');
  if (implementation) {
    await documents.putDocument(seeded, 'implementation', 'changed the field\n');
    await documents.putDocument(seeded, 'review_report', 'Ships the field.\n');
  }
}

/** A pushed feature branch whose origin url points at the gitlab host. */
function featureTree(root: string): string {
  const clone = join(root, 'demo');
  const remote = join(root, 'demo.git');
  const tree = join(root, 'worktrees', KEY, 'demo');
  const branch = `feature/${KEY}-ship-the-field`;
  runGit(root, ['init', '-q', '-b', 'main', clone]);
  mkdirSync(join(clone, 'src'), { recursive: true });
  writeFileSync(join(clone, 'src', 'readme.ts'), 'export const readme = 1;\n');
  runGit(clone, ['add', 'src/readme.ts']);
  runGit(clone, ['commit', '-q', '-m', 'init']);
  runGit(root, ['init', '-q', '--bare', remote]);
  runGit(clone, ['remote', 'add', 'origin', remote]);
  runGit(clone, ['push', '-q', '-u', 'origin', 'main']);
  runGit(clone, ['remote', 'set-head', 'origin', 'main']);
  runGit(clone, ['switch', '-q', '-c', 'holder']);
  mkdirSync(join(tree, '..'), { recursive: true });
  runGit(clone, ['worktree', 'add', '-q', '-b', branch, tree, 'main']);
  runGit(tree, ['push', '-q', '-u', 'origin', branch]);
  runGit(tree, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/demo.git']);
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
    'GITLAB_BASE_URL=https://gitlab.example',
    'GITLAB_TOKEN=golden-token',
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
