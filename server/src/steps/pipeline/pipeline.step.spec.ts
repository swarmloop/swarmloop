import 'reflect-metadata';

import { execFileSync } from 'child_process';

import { getRepositoryToken } from '@nestjs/typeorm';

import { mkdirSync } from 'fs';

import { mkdtemp, writeFile } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import type { Repository } from 'typeorm';

import { LoopEventEntity } from '../../history/entities';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { PipelineService } from '../../pipeline/pipeline.service';

import { RunRebase } from '../run-rebase';

import { RunStop } from '../../agent/run-stop';

import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';

import { FetchFailed } from '../../core/swarmloop-error';

import { gitRepo, one, two, shot, job, call, restore, boot, seed, TOKEN } from './pipeline.step.spec-helpers';
import { EnvironmentService } from '../../environment/environment.service';
import { REBASE_JOURNAL, parseJournal } from '../../git/rebase';
import { featureWorktree, git, hostFetch } from '../../testing/runs.spec-helpers';

describe('pipeline step', () => {
  it.each(['start', 'resume', 'failure', 'dirty', 'limit', 'stop'] as const)(
    'uses the button rebase action for missing CI: %s',
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-auto-rebase-'));
      const app = await boot(
        root,
        jest.fn(async () => ({ snapshot: null, httpCalls: [] })),
        jest.fn(),
      );
      try {
        const key = 'PROJ-320';
        const cwd = join(root, 'worktrees', key, 'demo');
        gitRepo(cwd, 'https://gitlab.example/group/demo.git');
        mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true });
        await writeFile(join(cwd, '.github', 'workflows', 'ci.yml'), 'name: CI\non: pull_request\n');
        execFileSync('git', ['checkout', '-b', 'feature/task'], { cwd });
        execFileSync('git', ['add', '.'], { cwd });
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', 'base'], { cwd });
        const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
        await seed(app, key, `project: group/demo\nref: feature/task\nsha: ${sha}\n`, mode === 'limit' ? 6 : 0);
        const documents = app.get(DocumentRepository);
        const runs = app.get(RunRepository);
        await documents.putDocument((await runs.findRun(key))!, 'repos', 'demo\n');
        app.get(CodeHostRegistry).byName('gitlab').diagnoseMissingPipeline = jest.fn(async () => ({
          reason: 'MR has conflicts',
          code: 'merge-conflict' as const,
          httpCalls: [],
        }));
        const action = jest.spyOn(app.get(RunRebase), 'rebase').mockImplementation(async () => {
          if (mode === 'failure') throw new Error('fetch failed');
          const run = (await runs.findRun(key))!;
          run.currentStep = mode === 'resume' ? 'pipeline' : 'implement';
          run.status = 'waiting';
          await runs.saveRun(run);
          return mode === 'resume' ? 'resume' : 'start';
        });
        if (mode === 'dirty') await writeFile(join(cwd, 'manual.txt'), 'manual edit');
        if (mode === 'stop') jest.spyOn(app.get(RunStop), 'halted').mockReturnValue(true);
        const result = await app.get(PipelineService).step('pipeline', key);
        if (mode === 'stop') {
          expect(action).not.toHaveBeenCalled();
          expect(result.message).toContain('Stopped by request');
          return;
        }
        if (mode === 'dirty' || mode === 'limit') {
          expect(action).not.toHaveBeenCalled();
          expect((await runs.findRun(key))?.status).toBe('blocked');
          return;
        }
        expect(action).toHaveBeenCalledTimes(1);
        expect(action).toHaveBeenCalledWith(key);
        if (mode === 'failure') {
          expect(result.exitCode).toBe(1);
          expect((await runs.findRun(key))?.status).toBe('blocked');
          expect(await documents.latestBody(key, 'error')).toContain('fetch failed');
          return;
        }
        expect(result.resume).toBe(mode === 'resume');
        expect(execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim()).toBe(sha);
        const again = (await runs.findRun(key))!;
        again.currentStep = 'pipeline';
        await runs.saveRun(again);
        const repeated = await app.get(PipelineService).step('pipeline', key);
        expect(repeated.message).toContain('already attempted');
        expect(action).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    },
  );

  it('goes through the journal and the generation when the merge request conflicts with its target', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-auto-journal-'));
    const key = 'PROJ-321';
    const { tree, clone } = featureWorktree(root, key);
    const branch = `feature/${key}-ship-the-field`;
    mkdirSync(join(tree, '.github', 'workflows'), { recursive: true });
    await writeFile(join(tree, '.github', 'workflows', 'ci.yml'), 'name: CI\non: pull_request\n');
    git(tree, ['add', '.']);
    git(tree, ['commit', '-m', 'field']);
    git(tree, ['push', '-u', 'origin', branch]);
    const sha = git(tree, ['rev-parse', 'HEAD']);
    git(clone, ['switch', 'main']);
    await writeFile(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    git(tree, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/demo.git']);
    const restoreFetch = hostFetch(join(root, 'demo.git'), TOKEN);
    const previousSsh = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = 'false';
    const app = await boot(
      root,
      jest.fn(async () => ({ snapshot: null, httpCalls: [] })),
      jest.fn(),
    );
    try {
      jest.spyOn(app.get(EnvironmentService), 'refreshAfterRebase').mockResolvedValue(undefined);
      await seed(app, key, `project: group/demo\nref: ${branch}\nsha: ${sha}\n`);
      const documents = app.get(DocumentRepository);
      const runs = app.get(RunRepository);
      const run = (await runs.findRun(key))!;
      await documents.putDocument(run, 'repos', 'demo\n');
      await documents.putDocument(
        run,
        'requirements',
        `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [] })}\n`,
      );
      app.get(CodeHostRegistry).byName('gitlab').diagnoseMissingPipeline = jest.fn(async () => ({
        reason: 'MR has conflicts',
        code: 'merge-conflict' as const,
        httpCalls: [],
      }));
      expect((await runs.findRun(key))?.generation).toBe(0);
      await app.get(PipelineService).step('pipeline', key);
      expect((await runs.findRun(key))?.generation).toBe(1);
      const journal = parseJournal(await documents.latestBody(key, REBASE_JOURNAL));
      expect(journal.demo).toMatchObject({
        branch,
        oldHead: sha,
        baseSha: base,
        checkpoint: 'completed',
        generation: 1,
      });
      expect(git(tree, ['rev-parse', 'HEAD^'])).toBe(base);
    } finally {
      if (previousSsh === undefined) {
        delete process.env.GIT_SSH_COMMAND;
      } else {
        process.env.GIT_SSH_COMMAND = previousSsh;
      }
      restoreFetch();
      await app.close();
    }
  });

  it('finishes when every pipeline succeeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-green-'));
    const read = jest.fn(() =>
      Promise.resolve({ snapshot: shot('success', [job(8, 'lint', true)]), httpCalls: [call('GET')] }),
    );
    const trace = jest.fn();
    const app = await boot(root, read, trace);
    try {
      await seed(app, 'PROJ-300');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-300');
      expect(result.exitCode).toBe(0);
      expect(trace).not.toHaveBeenCalled();
      const run = await app.get(RunRepository).findRun('PROJ-300');
      expect(run?.status).toBe('done');
      expect(run?.currentStep).toBe('done');
      expect(run?.attemptsPipeline).toBe(0);
      const body = await app.get(DocumentRepository).latestBody('PROJ-300', 'pipeline_log');
      expect(body).toContain('result: pass');
      expect(body).toContain('warning: group/demo lint');
    } finally {
      await app.close();
    }
  });

  it('returns to implement once when several blocking jobs failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-red-'));
    const read = jest.fn((ref: { project: string }) => {
      if (ref.project === 'group/web') {
        return Promise.resolve({ snapshot: shot('success', []), httpCalls: [call('GET')] });
      }
      return Promise.resolve({
        snapshot: shot('failed', [job(7, 'unit', false), job(8, 'lint', true), job(9, 'e2e', false)]),
        httpCalls: [call('GET')],
      });
    });
    const trace = jest.fn((_project: string, jobId: number) =>
      Promise.resolve({ trace: `log ${jobId}\n`, httpCalls: [call('GET')] }),
    );
    const app = await boot(root, read, trace);
    try {
      await seed(app, 'PROJ-301', two);
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-301');
      expect(result.exitCode).toBe(0);
      expect(trace.mock.calls.map((item) => item[1])).toEqual([7, 9]);
      const run = await app.get(RunRepository).findRun('PROJ-301');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsPipeline).toBe(1);
      const body = await app.get(DocumentRepository).latestBody('PROJ-301', 'pipeline_log');
      expect(body).toContain('result: fail');
      expect(body).toContain('job: unit');
      expect(body).toContain('log 7');
      expect(body).toContain('job: e2e');
      expect(body).not.toContain('job: lint');
      const loops = await app.get<Repository<LoopEventEntity>>(getRepositoryToken(LoopEventEntity)).find();
      expect(loops).toHaveLength(1);
      expect(loops[0]?.counter).toBe('pipeline');
      expect(loops[0]?.attempt).toBe(1);
      const notes = await app.get(DocumentRepository).latestBody('PROJ-301', 'return');
      expect(notes).toContain('## pipeline');
      expect(notes).toContain('result: fail');
      expect(notes).toContain('log 7');
    } finally {
      await app.close();
    }
  });

  it('does not send the same failed run back to implement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-same-'));
    const read = jest.fn(() =>
      Promise.resolve({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] }),
    );
    const app = await boot(
      root,
      read,
      jest.fn(() => Promise.resolve({ trace: 'log 7\n', httpCalls: [call('GET')] })),
    );
    try {
      await seed(app, 'PROJ-314');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const seeded = await runs.findRun('PROJ-314');
      await documents.putDocument(
        seeded!,
        'pipeline_log',
        'result: fail\nproject: group/demo\npipeline: 9\njob: unit\n',
      );
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-314', { auto: true });
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('pipeline already failed for this commit');
      const run = await runs.findRun('PROJ-314');
      expect(run?.currentStep).toBe('pipeline');
      expect(run?.status).toBe('failed');
      expect(run?.attemptsPipeline).toBe(0);
      expect(await documents.latestBody('PROJ-314', 'return')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('reads the pipeline on the sha written after a rerun', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-rerun-'));
    const read = jest.fn((_ref: { project: string; ref: string; sha: string }) =>
      Promise.resolve({ snapshot: shot('success', [job(8, 'lint', true)]), httpCalls: [call('GET')] }),
    );
    const app = await boot(root, read, jest.fn());
    try {
      await seed(app, 'PROJ-315', `${one}sha: ${'a'.repeat(40)}\n`);
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const seeded = await runs.findRun('PROJ-315');
      await documents.putDocument(seeded!, 'pipeline_ref', `${one}sha: ${'b'.repeat(40)}\n`);
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-315');
      expect(result.exitCode).toBe(0);
      expect(read).toHaveBeenCalledTimes(1);
      expect(read.mock.calls[0]?.[0].sha).toBe('b'.repeat(40));
    } finally {
      await app.close();
    }
  });

  it('returns to implement when a person resumes the same failed run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-resume-'));
    const read = jest.fn(() =>
      Promise.resolve({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] }),
    );
    const app = await boot(
      root,
      read,
      jest.fn(() => Promise.resolve({ trace: 'log 7\n', httpCalls: [call('GET')] })),
    );
    try {
      await seed(app, 'PROJ-317');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const seeded = await runs.findRun('PROJ-317');
      await documents.putDocument(
        seeded!,
        'pipeline_log',
        'result: fail\nproject: group/demo\npipeline: 9\njob: unit\n',
      );
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-317');
      expect(result.exitCode).toBe(0);
      const run = await runs.findRun('PROJ-317');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsPipeline).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('returns to implement when the failed run is a new one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-new-'));
    const read = jest.fn(() =>
      Promise.resolve({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] }),
    );
    const app = await boot(
      root,
      read,
      jest.fn(() => Promise.resolve({ trace: 'log 7\n', httpCalls: [call('GET')] })),
    );
    try {
      await seed(app, 'PROJ-315');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const seeded = await runs.findRun('PROJ-315');
      await documents.putDocument(
        seeded!,
        'pipeline_log',
        'result: fail\nproject: group/demo\npipeline: 8\njob: unit\n',
      );
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-315');
      expect(result.exitCode).toBe(0);
      const run = await runs.findRun('PROJ-315');
      expect(run?.currentStep).toBe('implement');
      expect(run?.attemptsPipeline).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('stops on pipeline when the pipeline return limit is already used', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-cap-'));
    const read = jest.fn(() =>
      Promise.resolve({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] }),
    );
    const app = await boot(
      root,
      read,
      jest.fn(() => Promise.resolve({ trace: 'log\n', httpCalls: [call('GET')] })),
      'MAX_PIPELINE_RETURNS=6\n',
    );
    try {
      await seed(app, 'PROJ-316', one, 6);
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-316');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('pipeline return limit reached');
      const run = await app.get(RunRepository).findRun('PROJ-316');
      expect(run?.currentStep).toBe('pipeline');
      expect(run?.status).toBe('blocked');
      expect(run?.attemptsPipeline).toBe(6);
      expect(await app.get(DocumentRepository).latestBody('PROJ-316', 'return')).toBeNull();
      expect(await app.get(DocumentRepository).latestBody('PROJ-316', 'pipeline_log')).toContain('result: fail');
    } finally {
      await app.close();
    }
  });

  it('finishes a red pipeline even when the counter is already at the limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-limit-'));
    const read = jest.fn(() =>
      Promise.resolve({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] }),
    );
    const app = await boot(
      root,
      read,
      jest.fn(() => Promise.resolve({ trace: 'log\n', httpCalls: [call('GET')] })),
    );
    try {
      await seed(app, 'PROJ-302', one, 3);
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-302');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('pipeline failed');
      const run = await app.get(RunRepository).findRun('PROJ-302');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsPipeline).toBe(4);
    } finally {
      await app.close();
    }
  });

  it('cancels a run that is still going after the timeout and returns its trace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-wait-'));
    let canceled = false;
    const read = jest.fn(() =>
      Promise.resolve({
        snapshot: shot(canceled ? 'canceled' : 'running', [job(7, 'unit', false, canceled ? 'failed' : 'in_progress')]),
        httpCalls: [call('GET')],
      }),
    );
    const cancel = jest.fn(() => {
      canceled = true;
      return Promise.resolve({ httpCalls: [call('POST')] });
    });
    const trace = jest.fn(() => Promise.resolve({ trace: 'log 7\n', httpCalls: [call('GET')] }));
    const app = await boot(
      root,
      read,
      trace,
      'TICK_MS=1\nPIPELINE_TIMEOUT_MS=0\nPIPELINE_START_TIMEOUT_MS=50\n',
      cancel,
    );
    try {
      await seed(app, 'PROJ-303');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-303');
      expect(result.exitCode).toBe(0);
      expect(cancel).toHaveBeenCalledWith('group/demo', 9);
      expect(result.message).toContain('pipeline failed');
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-303');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsPipeline).toBe(1);
      const body = await documents.latestBody('PROJ-303', 'pipeline_log');
      expect(body?.startsWith('It was still running after 0 minutes and swarmloop canceled it')).toBe(true);
      expect(body).toContain('log 7');
      const notes = await documents.latestBody('PROJ-303', 'return');
      expect(notes).toContain('## pipeline');
      expect(notes).toContain('It was still running after 0 minutes and swarmloop canceled it');
      expect(notes).toContain('log 7');
    } finally {
      await app.close();
    }
  });

  it('returns to implement when canceling a timed-out run fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-cancel-fail-'));
    const read = jest.fn((_ref: { project: string }, jobs = true) =>
      Promise.resolve({
        snapshot: shot('running', jobs ? [job(7, 'unit', false, 'in_progress')] : []),
        httpCalls: [call('GET')],
      }),
    );
    const cancel = jest.fn(() => Promise.reject(new FetchFailed('github pipeline failed: HTTP 500', [call('POST')])));
    const trace = jest.fn(() => Promise.resolve({ trace: 'secret trace\n', httpCalls: [call('GET')] }));
    const app = await boot(
      root,
      read,
      trace,
      'TICK_MS=1\nPIPELINE_TIMEOUT_MS=0\nPIPELINE_START_TIMEOUT_MS=50\n',
      cancel,
    );
    try {
      await seed(app, 'PROJ-318');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-318');
      expect(result.exitCode).toBe(0);
      expect(cancel).toHaveBeenCalledWith('group/demo', 9);
      expect(read.mock.calls.map((entry) => entry[1] === true)).toEqual([false, true]);
      expect(trace).not.toHaveBeenCalled();
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await runs.findRun('PROJ-318');
      expect(run?.currentStep).toBe('implement');
      expect(run?.attemptsPipeline).toBe(1);
      const notes = await documents.latestBody('PROJ-318', 'return');
      expect(notes).toContain('result: fail');
      expect(notes).toContain('job: unit');
      expect(notes).toContain('cancel: group/demo: github pipeline failed: HTTP 500');
      expect(notes).not.toContain('secret trace');
    } finally {
      await app.close();
    }
  });

  it('polls again after a running pipeline and then finishes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-poll-'));
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    let reads = 0;
    const read = jest.fn(() => {
      reads += 1;
      const status = reads === 1 ? 'running' : 'success';
      return Promise.resolve({ snapshot: shot(status, []), httpCalls: [call('GET')] });
    });
    const app = await boot(root, read, jest.fn(), 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=5000\n');
    try {
      await seed(app, 'PROJ-304');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-304');
      expect(result.exitCode).toBe(0);
      expect(read).toHaveBeenCalledTimes(2);
      expect((await app.get(RunRepository).findRun('PROJ-304'))?.currentStep).toBe('done');
      expect((await app.get(RunRepository).findRun('PROJ-304'))?.status).toBe('done');
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      await app.close();
    }
  });

  it('waits when a person still has to start a manual pipeline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-manual-'));
    const app = await boot(
      root,
      jest.fn(() => Promise.resolve({ snapshot: shot('manual', []), httpCalls: [call('GET')] })),
      jest.fn(),
    );
    try {
      await seed(app, 'PROJ-305');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-305');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('pipeline is manual');
      expect((await app.get(RunRepository).findRun('PROJ-305'))?.attemptsPipeline).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('returns a canceled pipeline to implement with and without auto', async () => {
    for (const auto of [false, true]) {
      const root = await mkdtemp(join(tmpdir(), `swarmloop-pipe-cancel-${auto}-`));
      const trace = jest.fn(() => Promise.resolve({ trace: 'canceled log\n', httpCalls: [call('GET')] }));
      const app = await boot(
        root,
        jest.fn(() =>
          Promise.resolve({ snapshot: shot('canceled', [job(7, 'unit', false)]), httpCalls: [call('GET')] }),
        ),
        trace,
      );
      try {
        await seed(app, 'PROJ-306');
        const result = await app.get(PipelineService).step('pipeline', 'PROJ-306', auto ? { auto: true } : {});
        expect(result.exitCode).toBe(0);
        expect(trace).toHaveBeenCalledWith('group/demo', 7);
        const runs = app.get(RunRepository);
        const documents = app.get(DocumentRepository);
        const run = await runs.findRun('PROJ-306');
        expect(run?.currentStep).toBe('implement');
        expect(run?.status).toBe('waiting');
        expect(run?.attemptsPipeline).toBe(1);
        const notes = await documents.latestBody('PROJ-306', 'return');
        expect(notes).toContain('## pipeline');
        expect(notes).toContain('result: fail');
        expect(notes).toContain('canceled log');
      } finally {
        await app.close();
      }
    }
  });

  it('stays put when the pipeline was skipped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-skip-'));
    const trace = jest.fn();
    const app = await boot(
      root,
      jest.fn(() => Promise.resolve({ snapshot: shot('skipped', []), httpCalls: [call('GET')] })),
      trace,
    );
    try {
      await seed(app, 'PROJ-319');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-319');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('pipeline was skipped');
      expect(trace).not.toHaveBeenCalled();
      const run = await app.get(RunRepository).findRun('PROJ-319');
      expect(run?.currentStep).toBe('pipeline');
      expect(run?.status).toBe('failed');
      expect(run?.attemptsPipeline).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('returns once when one pipeline failed and another is still running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-mixed-'));
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    const read = jest.fn((ref: { project: string }) => {
      if (ref.project === 'group/web') {
        return Promise.resolve({ snapshot: shot('running', []), httpCalls: [call('GET')] });
      }
      return Promise.resolve({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] });
    });
    const app = await boot(
      root,
      read,
      jest.fn(() => Promise.resolve({ trace: 'log\n', httpCalls: [call('GET')] })),
      'TICK_MS=1\nPIPELINE_TIMEOUT_MS=5000\n',
    );
    try {
      await seed(app, 'PROJ-308', two);
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-308');
      expect(result.exitCode).toBe(0);
      expect(read).toHaveBeenCalledTimes(2);
      const run = await app.get(RunRepository).findRun('PROJ-308');
      expect(run?.currentStep).toBe('implement');
      expect(run?.attemptsPipeline).toBe(1);
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      await app.close();
    }
  });
});
