import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Repository } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { HttpCallEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER, AgentRunResult } from '../../limits/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { MergeRequestDraft } from '../../integrations/code-host/code-host';
import { CodeHosts } from '../../providers/code-hosts';
import { SandboxService } from '../../sandbox/sandbox.service';
import { FetchFailed, HttpCallDraft } from '../../swarmloop-error';
import { REBASE_MERGE_SKIP } from './merge-request.service';

const TOKEN = 'super-secret-token';

describe('merge-request step', () => {
  it('opens one merge request and stores the summary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-open-'));
    featureTree(root, 'PROJ-200');
    const find = jest.fn(async () => ({ record: null, httpCalls: [call('GET')] }));
    const open = jest.fn(async (_draft: MergeRequestDraft) => ({
      record: { project: 'group/demo', iid: 12, url: 'https://gitlab.example/group/demo/-/merge_requests/12', summary: '' },
      httpCalls: [call('POST')],
    }));
    const agent = jest.fn(async (_input: { mounts: { readonly?: boolean }[]; prompt: string }) => result('Ships the field.\n'));
    const app = await boot(root, { find, open }, agent);
    try {
      await seed(app, 'PROJ-200');
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-200');
      expect(opened.exitCode).toBe(0);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]?.[0]).toMatchObject({
        project: 'group/demo',
        source: 'feature/PROJ-200-ship-the-field',
        target: 'main',
        title: 'Ship the field',
        summary: 'Ships the field.',
      });
      expect(agent).not.toHaveBeenCalled();
      const body = await app.get(HistoryService).latestBody('PROJ-200', 'merge_request');
      expect(body).toContain('project: group/demo');
      expect(body).toContain('iid: 12');
      expect(body).toContain('https://gitlab.example/group/demo/-/merge_requests/12');
      expect(body).toContain('Ships the field.');
      const run = await app.get(HistoryService).findRun('PROJ-200');
      expect(run?.currentStep).toBe('pipeline');
      expect(run?.status).toBe('waiting');
      expect(readFileSync(join(root, 'data', 'swarmloop.sqlite')).toString('utf8')).not.toContain(TOKEN);
    } finally {
      await app.close();
    }
  });

  it('updates an open merge request with the new description', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-reuse-'));
    featureTree(root, 'PROJ-201');
    const find = jest.fn(async () => ({
      record: {
        project: 'group/demo',
        iid: 9,
        url: 'https://gitlab.example/group/demo/-/merge_requests/9',
        summary: 'Already open.',
      },
      httpCalls: [call('GET')],
    }));
    const open = jest.fn();
    const update = jest.fn(async () => ({ httpCalls: [call('PUT')] }));
    const agent = jest.fn(async () => result('Ships the field.\n'));
    const app = await boot(root, { find, open, update }, agent);
    try {
      await seed(app, 'PROJ-201');
      const reused = await app.get(PipelineService).step('merge-request', 'PROJ-201');
      expect(reused.exitCode).toBe(0);
      expect(open).not.toHaveBeenCalled();
      expect(agent).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledWith('group/demo', 9, 'Ships the field.');
      const body = await app.get(HistoryService).latestBody('PROJ-201', 'merge_request');
      expect(body).toContain('iid: 9');
      expect(body).toContain('Ships the field.');
      expect((await app.get(HistoryService).findRun('PROJ-201'))?.currentStep).toBe('pipeline');
    } finally {
      await app.close();
    }
  });

  it('skips an existing merge request marked by a done rebase and updates on the next visit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-skip-'));
    featureTree(root, 'PROJ-212');
    const find = jest.fn(async () => ({
      record: {
        project: 'group/demo',
        iid: 9,
        url: 'https://gitlab.example/group/demo/-/merge_requests/9',
        summary: 'Already open.',
      },
      httpCalls: [call('GET')],
    }));
    const open = jest.fn();
    const update = jest.fn(async () => ({ httpCalls: [call('PUT')] }));
    const app = await boot(root, { find, open, update }, jest.fn(async () => result('Ships the field.\n')));
    try {
      const history = app.get(HistoryService);
      await seed(app, 'PROJ-212');
      const run = await history.findRun('PROJ-212');
      if (!run) {
        throw new Error('run is missing');
      }
      await history.putDocument(run, REBASE_MERGE_SKIP, 'skip\n');
      const skipped = await app.get(PipelineService).step('merge-request', 'PROJ-212');
      expect(skipped.exitCode).toBe(0);
      expect(open).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(await history.latestBody('PROJ-212', 'merge_request')).toContain('Already open.');
      expect((await history.latestBody('PROJ-212', REBASE_MERGE_SKIP))?.trim()).toBe('clear');
      expect((await history.findRun('PROJ-212'))?.currentStep).toBe('pipeline');
      expect((await history.findRun('PROJ-212'))?.status).toBe('waiting');
      const again = await app.get(PipelineService).step('merge-request', 'PROJ-212');
      expect(again.exitCode).toBe(0);
      expect(update).toHaveBeenCalledWith('group/demo', 9, 'Ships the field.');
    } finally {
      await app.close();
    }
  });

  it('creates only the missing merge request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-partial-'));
    featureTree(root, 'PROJ-202', 'demo');
    featureTree(root, 'PROJ-202', 'web');
    const find = jest.fn(async (query: { project: string }) => {
      if (query.project === 'group/web') {
        return {
          record: { project: 'group/web', iid: 4, url: 'https://gitlab.example/group/web/-/merge_requests/4', summary: 'Web is open.' },
          httpCalls: [call('GET')],
        };
      }
      return { record: null, httpCalls: [call('GET')] };
    });
    const open = jest.fn(async (_draft: MergeRequestDraft) => ({
      record: { project: 'group/demo', iid: 12, url: 'https://gitlab.example/group/demo/-/merge_requests/12', summary: '' },
      httpCalls: [call('POST')],
    }));
    const update = jest.fn(async () => ({ httpCalls: [call('PUT')] }));
    const agent = jest.fn(async (input: { mounts: { containerPath: string }[] }) =>
      result((input.mounts[0]?.containerPath ?? '').includes('web') ? 'Web change.\n' : 'Demo change.\n'),
    );
    const app = await boot(root, { find, open, update }, agent);
    try {
      await seed(app, 'PROJ-202', { repos: 'demo\nweb\n' });
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-202');
      expect(opened.exitCode).toBe(0);
      expect(find).toHaveBeenCalledTimes(2);
      expect(agent).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]?.[0]?.project).toBe('group/demo');
      expect(open.mock.calls[0]?.[0]?.summary).toBe('Ships the field.');
      expect(update).toHaveBeenCalledWith('group/web', 4, 'Ships the field.');
      const body = await app.get(HistoryService).latestBody('PROJ-202', 'merge_request');
      expect(body).toContain('iid: 4');
      expect(body).toContain('iid: 12');
      expect(body).toContain('Ships the field.');
    } finally {
      await app.close();
    }
  });

  it('stops when a later commit is not pushed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-ahead-'));
    const tree = featureTree(root, 'PROJ-208');
    writeFileSync(join(tree, 'src', 'later.ts'), 'export const later = 1;\n');
    git(tree, ['add', 'src/later.ts']);
    git(tree, ['commit', '-m', 'later']);
    const find = jest.fn();
    const app = await boot(root, { find, open: jest.fn() }, jest.fn());
    try {
      await seed(app, 'PROJ-208');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-208');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('demo branch is not pushed');
      expect(find).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('uses main when the remote has no default branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-default-'));
    const tree = featureTree(root, 'PROJ-209');
    git(tree, ['remote', 'set-head', 'origin', '-d']);
    const open = jest.fn(async (_draft: MergeRequestDraft) => ({
      record: { project: 'group/demo', iid: 3, url: 'https://gitlab.example/group/demo/-/merge_requests/3', summary: '' },
      httpCalls: [call('POST')],
    }));
    const app = await boot(root, { find: jest.fn(async () => ({ record: null, httpCalls: [call('GET')] })), open }, jest.fn(async () => result('Fallback.\n')));
    try {
      await seed(app, 'PROJ-209');
      const opened = await app.get(PipelineService).step('merge-request', 'PROJ-209');
      expect(opened.exitCode).toBe(0);
      expect(open.mock.calls[0]?.[0]?.target).toBe('main');
    } finally {
      await app.close();
    }
  });

  it('stops when the remote default branch is the feature branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-self-'));
    const tree = featureTree(root, 'PROJ-210');
    git(tree, ['remote', 'set-head', 'origin', 'feature/PROJ-210-ship-the-field']);
    const find = jest.fn();
    const app = await boot(root, { find, open: jest.fn() }, jest.fn());
    try {
      await seed(app, 'PROJ-210');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-210');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('target branch is the feature branch');
      expect(find).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('stops when the feature branch is not on origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-unpushed-'));
    featureTree(root, 'PROJ-203', 'demo', false);
    const find = jest.fn();
    const agent = jest.fn();
    const app = await boot(root, { find, open: jest.fn() }, agent);
    try {
      await seed(app, 'PROJ-203');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-203');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('demo branch is not pushed');
      expect(find).not.toHaveBeenCalled();
      expect(agent).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('stops when origin is a different host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-host-'));
    const tree = featureTree(root, 'PROJ-204');
    git(tree, ['remote', 'set-url', 'origin', 'git@other.example:group/demo.git']);
    const find = jest.fn();
    const app = await boot(root, { find, open: jest.fn() }, jest.fn());
    try {
      await seed(app, 'PROJ-204');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-204');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('origin is not GITLAB_BASE_URL');
      expect(find).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('finishes when ci was skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-skip-'));
    const find = jest.fn();
    const open = jest.fn();
    const app = await boot(root, { find, open }, jest.fn());
    try {
      await seed(app, 'PROJ-206');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-206');
      if (!run) {
        throw new Error('run is missing');
      }
      await history.putDocument(run, 'ci_skip', 'CI skipped: there is no origin to push.\n');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-206');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('CI skipped: there is no origin to push.');
      expect(find).not.toHaveBeenCalled();
      expect(open).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('names a missing token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-token-'));
    const app = await boot(root, { find: jest.fn(), open: jest.fn() }, jest.fn(), '');
    try {
      await seed(app, 'PROJ-205');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-205');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('GITLAB_TOKEN is missing');
    } finally {
      await app.close();
    }
  });

  it('keeps the gitlab call when the host rejects the request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-mr-reject-'));
    featureTree(root, 'PROJ-207');
    const find = jest.fn(async () => {
      throw new FetchFailed('GITLAB_TOKEN was rejected', [call('GET', 401)]);
    });
    const app = await boot(root, { find, open: jest.fn() }, jest.fn());
    try {
      await seed(app, 'PROJ-207');
      const result = await app.get(PipelineService).step('merge-request', 'PROJ-207');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('GITLAB_TOKEN was rejected');
      const calls = await app.get<Repository<HttpCallEntity>>(getRepositoryToken(HttpCallEntity)).find();
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).not.toContain(TOKEN);
    } finally {
      await app.close();
    }
  });
});

function call(method: string, statusCode = 200): HttpCallDraft {
  return {
    provider: 'gitlab',
    method,
    url: 'https://gitlab.example/api/v4/projects/group%2Fdemo/merge_requests',
    statusCode,
    durationMs: 1,
    error: statusCode === 200 ? null : `HTTP ${statusCode}`,
  };
}

function result(responseText: string): AgentRunResult {
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

async function boot(
  root: string,
  host: { find: jest.Mock; open: jest.Mock; update?: jest.Mock },
  agent: jest.Mock,
  token = TOKEN,
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
      `GITLAB_TOKEN=${token}`,
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
    .overrideProvider(CodeHosts)
    .useValue({
      get: () => ({
        findMergeRequest: host.find,
        openMergeRequest: host.open,
        updateMergeRequest: host.update ?? jest.fn(async () => ({ httpCalls: [] })),
        readBranchPipeline: jest.fn(),
        readJobTrace: jest.fn(),
      }),
    })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: agent })
    .overrideProvider(SandboxService)
    .useValue({ assertReady: jest.fn().mockResolvedValue(undefined) })
    .compile();
}

async function seed(
  app: Awaited<ReturnType<typeof boot>>,
  key: string,
  options: { implementation?: boolean; repos?: string } = {},
): Promise<void> {
  const history = app.get(HistoryService);
  const seeded = await history.begin(key, 'merge-request');
  seeded.status = 'waiting';
  seeded.currentStep = 'commit';
  seeded.codeHost = 'gitlab';
  await history.saveRun(seeded);
  await history.putDocument(
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
  await history.putDocument(seeded, 'repos', options.repos ?? 'demo\n');
  await history.putDocument(seeded, 'pipeline_log', 'result: pass\n');
  if (options.implementation !== false) {
    await history.putDocument(seeded, 'implementation', 'changed the field\n');
    await history.putDocument(seeded, 'review_report', 'Ships the field.\n');
  }
}

function featureTree(root: string, key: string, repo = 'demo', pushed = true): string {
  const clone = join(root, repo);
  const remote = join(root, `${repo}.git`);
  const tree = join(root, 'worktrees', key, repo);
  const branch = `feature/${key}-ship-the-field`;
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
  git(clone, ['remote', 'set-head', 'origin', 'main']);
  git(clone, ['switch', '-c', 'holder']);
  mkdirSync(join(tree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '-b', branch, tree, 'main']);
  if (pushed) {
    git(tree, ['push', '-u', 'origin', branch]);
  }
  git(tree, ['remote', 'set-url', 'origin', `git@gitlab.example:group/${repo}.git`]);
  return tree;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
