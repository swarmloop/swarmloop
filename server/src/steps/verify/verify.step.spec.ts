import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { Test } from '@nestjs/testing';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SwarmloopConfigModule } from '../../config/config.module';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { LiveHub } from '../../live/live.hub';
import { LiveModule } from '../../live/live.module';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { VerifyService, type VerifyOutputLine, type VerifyResult } from '../../verify/verify.service';
import { fixNotes } from '../code-review/review-input';
import { parseVerifyLog } from './verify-record';

const KEY = 'PROJ-90';

const failure = (tail = 'FAIL src/a.spec.ts', command = 'npm test'): VerifyResult => ({
  status: 'failed',
  commands: [{ command, exitCode: 1, tail }],
  warnings: [],
  installChanged: [],
  durationMs: 4000,
  message: `${command} exited 1`,
});

const passing: VerifyResult = {
  status: 'ok',
  commands: [
    { command: 'npm ci', exitCode: 0, tail: '' },
    { command: 'npm test', exitCode: 0, tail: '' },
  ],
  warnings: [],
  installChanged: [],
  durationMs: 12_000,
};

describe('verify step', () => {
  it('shows the commands in the log file and the live entry while they run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-verify-live-'));
    const seen: { file: string; live: string[] } = { file: '', live: [] };
    let log!: jest.SpyInstance;
    const run = jest.fn(async (input: { onOutput?: (line: VerifyOutputLine) => void }) => {
      input.onOutput?.({ command: 'npm test', stream: 'stdout', text: '$ npm test' });
      input.onOutput?.({ command: 'npm test', stream: 'stdout', text: 'running' });
      const file = join(root, 'data', `${KEY}-verify-output.txt`);
      for (let turn = 0; turn < 500 && log.mock.calls.length === 0; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      seen.file = readFileSync(file, 'utf8');
      seen.live = log.mock.calls.map((call) => (call[0] as { body: string }).body);
      return passing;
    });
    const app = await boot(root, run);
    log = jest.spyOn(app.get(LiveHub), 'log');
    try {
      await seed(app, root);
      await app.get(PipelineService).step('verify', KEY);
      expect(seen.file).toContain('== gate ==\n$ npm test\n');
      expect(seen.live[0]).toContain('== gate ==\n$ npm test\n');
      const written = readFileSync(join(root, 'data', `${KEY}-verify-output.txt`), 'utf8');
      expect(written.endsWith('process exited 0\n')).toBe(true);
      expect(log).toHaveBeenLastCalledWith(expect.objectContaining({ key: KEY, step: 'verify' }));
    } finally {
      await app.close();
    }
  });

  it('finishes ok at once when no repository has a manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-verify-skip-'));
    const run = jest.fn().mockResolvedValue({ status: 'skipped' });
    const app = await boot(root, run);
    try {
      await seed(app, root);
      const done = await app.get(PipelineService).step('verify', KEY);
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('verify skipped: no .swarmloop.json');
      const stored = await app.get(RunRepository).findRun(KEY);
      expect(stored?.currentStep).toBe('code-review');
      expect(await kinds(app)).toEqual(['handoff', 'implementation', 'repos', 'requirements'].sort());
      expect(existsSync(join(root, 'data', `${KEY}-verify-output.txt`))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('writes a verify_log and leaves what the reviewers read as it was', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-verify-ok-'));
    const run = jest.fn().mockResolvedValue(passing);
    const app = await boot(root, run);
    try {
      await seed(app, root);
      const documents = app.get(DocumentRepository);
      const stored = (await app.get(RunRepository).findRun(KEY))!;
      const before = fixNotes(await documents.listDocuments(stored.id), await documents.latestBody(KEY, 'handoff'));
      const done = await app.get(PipelineService).step('verify', KEY);
      expect(done.exitCode).toBe(0);
      const record = parseVerifyLog((await documents.latestBody(KEY, 'verify_log')) ?? '');
      expect(record).toMatchObject({ result: 'pass', commands: ['npm ci', 'npm test'] });
      expect(await kinds(app)).toEqual(['handoff', 'implementation', 'repos', 'requirements', 'verify_log'].sort());
      const after = fixNotes(await documents.listDocuments(stored.id), await documents.latestBody(KEY, 'handoff'));
      expect(after).toEqual(before);
      expect((await app.get(RunRepository).findRun(KEY))?.currentStep).toBe('code-review');
    } finally {
      await app.close();
    }
  });

  it('returns to implement with the failing command, its exit code and its tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-verify-red-'));
    const run = jest.fn().mockResolvedValue(failure('line one\nFAIL src/a.spec.ts'));
    const app = await boot(root, run);
    try {
      await seed(app, root);
      const done = await app.get(PipelineService).step('verify', KEY);
      expect(done.exitCode).toBe(0);
      const returned = (await app.get(DocumentRepository).latestBody(KEY, 'return')) ?? '';
      expect(returned.startsWith('verify failed (it ran in ')).toBe(true);
      expect(returned).toContain(', not in your container)');
      expect(returned).toContain('command: npm test\nexit code: 1\nline one\nFAIL src/a.spec.ts');
      const stored = await app.get(RunRepository).findRun(KEY);
      expect(stored?.currentStep).toBe('implement');
      expect(stored?.status).toBe('waiting');
      expect(await kinds(app)).toEqual(
        ['handoff', 'implementation', 'repos', 'requirements', 'return', 'verify_log'].sort(),
      );
    } finally {
      await app.close();
    }
  });

  it('fails with the exact text when the environment is broken and does not return', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-verify-error-'));
    const run = jest.fn().mockResolvedValue({
      status: 'error',
      commands: [],
      warnings: [],
      installChanged: [],
      durationMs: 1,
      message: 'docker could not start: spawn docker ENOENT',
    });
    const app = await boot(root, run);
    try {
      await seed(app, root);
      const done = await app.get(PipelineService).step('verify', KEY);
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('docker could not start: spawn docker ENOENT');
      const stored = await app.get(RunRepository).findRun(KEY);
      expect(stored?.currentStep).toBe('verify');
      expect(stored?.status).toBe('failed');
      expect(await app.get(DocumentRepository).latestBody(KEY, 'return')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('blocks when the return limit is reached', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-verify-limit-'));
    const run = jest.fn().mockResolvedValueOnce(failure('first')).mockResolvedValueOnce(failure('second'));
    const app = await boot(root, run, 'MAX_VERIFY_RETURNS=1\n');
    try {
      const worktree = await seed(app, root);
      await app.get(PipelineService).step('verify', KEY);
      writeFileSync(join(worktree, 'changed.txt'), 'changed\n');
      const done = await app.get(PipelineService).step('verify', KEY);
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('verify return limit reached');
      expect(done.message).toContain('second');
      expect((await app.get(RunRepository).findRun(KEY))?.status).toBe('blocked');
    } finally {
      await app.close();
    }
  });

  it('blocks at once when the same command fails with the same tail and nothing changed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-verify-same-'));
    const run = jest.fn().mockResolvedValue(failure('same tail'));
    const app = await boot(root, run);
    try {
      await seed(app, root);
      await app.get(PipelineService).step('verify', KEY);
      const done = await app.get(PipelineService).step('verify', KEY);
      expect(done.message).toContain('verify failed twice with no change');
      expect((await app.get(RunRepository).findRun(KEY))?.status).toBe('blocked');
    } finally {
      await app.close();
    }
  });

  it('keeps going when the same failure comes back after a change', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-verify-changed-'));
    const run = jest.fn().mockResolvedValue(failure('same tail'));
    const app = await boot(root, run);
    try {
      const worktree = await seed(app, root);
      await app.get(PipelineService).step('verify', KEY);
      writeFileSync(join(worktree, 'changed.txt'), 'changed\n');
      await app.get(PipelineService).step('verify', KEY);
      const stored = await app.get(RunRepository).findRun(KEY);
      expect(stored?.currentStep).toBe('implement');
      expect(stored?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('runs nothing when the tree already passed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-verify-proven-'));
    const run = jest.fn().mockResolvedValue(passing);
    const app = await boot(root, run);
    try {
      await seed(app, root);
      await app.get(PipelineService).step('verify', KEY);
      const done = await app.get(PipelineService).step('verify', KEY);
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('verify passed on this exact tree already');
      expect(run).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

async function kinds(app: Awaited<ReturnType<typeof boot>>): Promise<string[]> {
  const run = (await app.get(RunRepository).findRun(KEY))!;
  const documents = await app.get(DocumentRepository).listDocuments(run.id);
  return [...new Set(documents.map((item) => item.kind))].sort();
}

async function boot(root: string, run: jest.Mock, extra = '') {
  await writeEnv(root, extra);
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), LiveModule, PipelineModule],
  })
    .overrideProvider(VerifyService)
    .useValue({ run })
    .compile();
}

async function seed(app: Awaited<ReturnType<typeof boot>>, root: string): Promise<string> {
  const worktree = featureTree(root, KEY, 'billing-api');
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(KEY, 'verify');
  seeded.status = 'waiting';
  seeded.currentStep = 'verify';
  await runs.saveRun(seeded);
  const plan = { name: '', overview: '', items: ['add the field'], decision: 'approve' };
  await documents.putDocument(
    seeded,
    'requirements',
    `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [{ key: KEY, summary: 'Ship the field' }], plan }, null, 2)}\n`,
  );
  await documents.putDocument(seeded, 'repos', 'billing-api\n');
  await documents.putDocument(seeded, 'implementation', '- changed the field parser\n');
  await documents.putDocument(seeded, 'handoff', '## implement\n- changed the parser\n');
  return worktree;
}

async function writeEnv(root: string, extra: string): Promise<void> {
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
      extra,
    ].join('\n'),
  );
}

function featureTree(root: string, key: string, repo: string): string {
  const clone = join(root, `${key}-${repo}`);
  const remote = join(root, `${key}-${repo}.git`);
  git(root, ['init', '-b', 'main', clone]);
  writeFileSync(join(clone, 'README'), `${repo}\n`);
  git(clone, ['add', 'README']);
  git(clone, ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-m', repo]);
  git(root, ['init', '--bare', remote]);
  git(clone, ['remote', 'add', 'origin', remote]);
  git(clone, ['push', '-u', 'origin', 'main']);
  const worktree = join(root, 'worktrees', key, repo);
  mkdirSync(join(worktree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '-b', `feature/${key}-ship-the-field`, worktree, 'origin/main']);
  return worktree;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
