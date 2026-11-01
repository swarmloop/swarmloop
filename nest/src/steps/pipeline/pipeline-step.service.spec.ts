import 'reflect-metadata';
import { execFileSync } from 'child_process';
import type { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { mkdirSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Repository } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { LoopEventEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { readableJobTrace } from './pipeline-step.service';
import { PipelineJob, PipelineSnapshot } from '../../integrations/code-host/code-host';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { FetchFailed, HttpCallDraft } from '../../swarmloop-error';

const TOKEN = 'super-secret-token';

describe('readable job trace', () => {
  it('keeps elixir failures and the summary, and drops the compile log', () => {
    const noise = Array.from({ length: 400 }, (_, index) => `Compiling ${index} files (.ex)`).join('\n');
    const trace = [
      'trace truncated',
      noise,
      'section_start:123:step_script',
      '............',
      '  1) test saves a lot (App.LotTest)',
      '     test/lot_test.exs:12',
      '     Assertion with == failed',
      '     code:  assert Repo.get(Lot, 1) == nil',
      '     left:  %Lot{}',
      '     right: nil',
      '     stacktrace:',
      '       test/lot_test.exs:14: (test)',
      '',
      'Finished in 1.2 seconds (0.4s async, 0.8s sync)',
      '18 tests, 1 failure',
    ].join('\n');
    const body = readableJobTrace(trace);
    expect(body).toContain('1) test saves a lot');
    expect(body).toContain('Assertion with == failed');
    expect(body).toContain('18 tests, 1 failure');
    expect(body).not.toContain('Compiling');
    expect(body).not.toContain('section_start');
  });

  it('keeps a short trace as it is', () => {
    expect(readableJobTrace('log 7\n')).toBe('log 7');
  });

  it('ends a github log at the failed step and drops the timestamp', () => {
    const stamp = '2026-10-30T18:05:51.3865192Z ';
    const trace = [
      `${stamp}npm test`,
      `${stamp}Assertion failed`,
      `${stamp}##[error]Process completed with exit code 1.`,
      `${stamp}service container output`,
      `${stamp}Stop and remove container`,
    ].join('\n');
    const body = readableJobTrace(trace);
    expect(body).toContain('npm test');
    expect(body).toContain('Assertion failed');
    expect(body.endsWith('##[error]Process completed with exit code 1.')).toBe(true);
    expect(body).not.toContain(stamp.trim());
    expect(body).not.toContain('Stop and remove container');
    expect(body).not.toContain('service container output');
  });

  it('keeps the gitlab step script and drops the after script', () => {
    const trace = [
      'section_start:1:step_script',
      'unit failed in the job',
      'section_end:2:step_script',
      'section_start:3:after_script',
      'after script removed the database',
      'section_end:4:after_script',
    ].join('\n');
    const body = readableJobTrace(trace);
    expect(body).toContain('unit failed in the job');
    expect(body).not.toContain('after script removed the database');
    expect(body).not.toContain('section_end');
  });

  it('returns the last 200 lines when the log has no end marker', () => {
    const lines = Array.from({ length: 250 }, (_, index) => `plain line ${index}`);
    const body = readableJobTrace(lines.join('\n'));
    expect(body.split('\n')).toHaveLength(200);
    expect(body.startsWith('plain line 50\n')).toBe(true);
    expect(body.endsWith('plain line 249')).toBe(true);
    expect(body).not.toContain('plain line 49\n');
  });

  it('caps a trace at its last 20000 characters', () => {
    const trace = `${'x'.repeat(50000)}tail`;
    const body = readableJobTrace(trace);
    expect(body).toHaveLength(20000);
    expect(body.endsWith('tail')).toBe(true);
    expect(body.startsWith('x')).toBe(true);
  });
});

describe('pipeline step', () => {
  it('finishes when every pipeline succeeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-green-'));
    const read = jest.fn(async () => ({ snapshot: shot('success', [job(8, 'lint', true)]), httpCalls: [call('GET')] }));
    const trace = jest.fn();
    const app = await boot(root, read, trace);
    try {
      await seed(app, 'PROJ-300');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-300');
      expect(result.exitCode).toBe(0);
      expect(trace).not.toHaveBeenCalled();
      const run = await app.get(HistoryService).findRun('PROJ-300');
      expect(run?.status).toBe('done');
      expect(run?.currentStep).toBe('done');
      expect(run?.attemptsPipeline).toBe(0);
      const body = await app.get(HistoryService).latestBody('PROJ-300', 'pipeline_log');
      expect(body).toContain('result: pass');
      expect(body).toContain('warning: group/demo lint');
    } finally {
      await app.close();
    }
  });

  it('returns to implement once when several blocking jobs failed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-red-'));
    const read = jest.fn(async (ref: { project: string }) => {
      if (ref.project === 'group/web') {
        return { snapshot: shot('success', []), httpCalls: [call('GET')] };
      }
      return {
        snapshot: shot('failed', [job(7, 'unit', false), job(8, 'lint', true), job(9, 'e2e', false)]),
        httpCalls: [call('GET')],
      };
    });
    const trace = jest.fn(async (_project: string, jobId: number) => ({ trace: `log ${jobId}\n`, httpCalls: [call('GET')] }));
    const app = await boot(root, read, trace);
    try {
      await seed(app, 'PROJ-301', two);
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-301');
      expect(result.exitCode).toBe(0);
      expect(trace.mock.calls.map((item) => item[1])).toEqual([7, 9]);
      const run = await app.get(HistoryService).findRun('PROJ-301');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsPipeline).toBe(1);
      const body = await app.get(HistoryService).latestBody('PROJ-301', 'pipeline_log');
      expect(body).toContain('result: fail');
      expect(body).toContain('job: unit');
      expect(body).toContain('log 7');
      expect(body).toContain('job: e2e');
      expect(body).not.toContain('job: lint');
      const loops = await app.get<Repository<LoopEventEntity>>(getRepositoryToken(LoopEventEntity)).find();
      expect(loops).toHaveLength(1);
      expect(loops[0]?.counter).toBe('pipeline');
      expect(loops[0]?.attempt).toBe(1);
      const notes = await app.get(HistoryService).latestBody('PROJ-301', 'return');
      expect(notes).toContain('## pipeline');
      expect(notes).toContain('result: fail');
      expect(notes).toContain('log 7');
    } finally {
      await app.close();
    }
  });

  it('does not send the same failed run back to implement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-same-'));
    const read = jest.fn(async () => ({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] }));
    const app = await boot(root, read, jest.fn(async () => ({ trace: 'log 7\n', httpCalls: [call('GET')] })));
    try {
      await seed(app, 'PROJ-314');
      const history = app.get(HistoryService);
      const seeded = await history.findRun('PROJ-314');
      await history.putDocument(seeded!, 'pipeline_log', 'result: fail\nproject: group/demo\npipeline: 9\njob: unit\n');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-314', { auto: true });
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('pipeline already failed for this commit');
      const run = await history.findRun('PROJ-314');
      expect(run?.currentStep).toBe('pipeline');
      expect(run?.status).toBe('failed');
      expect(run?.attemptsPipeline).toBe(0);
      expect(await history.latestBody('PROJ-314', 'return')).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('returns to implement when a person resumes the same failed run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-resume-'));
    const read = jest.fn(async () => ({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] }));
    const app = await boot(root, read, jest.fn(async () => ({ trace: 'log 7\n', httpCalls: [call('GET')] })));
    try {
      await seed(app, 'PROJ-317');
      const history = app.get(HistoryService);
      const seeded = await history.findRun('PROJ-317');
      await history.putDocument(seeded!, 'pipeline_log', 'result: fail\nproject: group/demo\npipeline: 9\njob: unit\n');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-317');
      expect(result.exitCode).toBe(0);
      const run = await history.findRun('PROJ-317');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsPipeline).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('returns to implement when the failed run is a new one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-new-'));
    const read = jest.fn(async () => ({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] }));
    const app = await boot(root, read, jest.fn(async () => ({ trace: 'log 7\n', httpCalls: [call('GET')] })));
    try {
      await seed(app, 'PROJ-315');
      const history = app.get(HistoryService);
      const seeded = await history.findRun('PROJ-315');
      await history.putDocument(seeded!, 'pipeline_log', 'result: fail\nproject: group/demo\npipeline: 8\njob: unit\n');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-315');
      expect(result.exitCode).toBe(0);
      const run = await history.findRun('PROJ-315');
      expect(run?.currentStep).toBe('implement');
      expect(run?.attemptsPipeline).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('stops on pipeline when the pipeline return limit is already used', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-cap-'));
    const read = jest.fn(async () => ({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] }));
    const app = await boot(root, read, jest.fn(async () => ({ trace: 'log\n', httpCalls: [call('GET')] })), 'MAX_PIPELINE_RETURNS=6\n');
    try {
      await seed(app, 'PROJ-316', one, 6);
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-316');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('pipeline return limit reached');
      const run = await app.get(HistoryService).findRun('PROJ-316');
      expect(run?.currentStep).toBe('pipeline');
      expect(run?.status).toBe('blocked');
      expect(run?.attemptsPipeline).toBe(6);
      expect(await app.get(HistoryService).latestBody('PROJ-316', 'return')).toBeNull();
      expect(await app.get(HistoryService).latestBody('PROJ-316', 'pipeline_log')).toContain('result: fail');
    } finally {
      await app.close();
    }
  });

  it('finishes a red pipeline even when the counter is already at the limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-limit-'));
    const read = jest.fn(async () => ({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] }));
    const app = await boot(root, read, jest.fn(async () => ({ trace: 'log\n', httpCalls: [call('GET')] })));
    try {
      await seed(app, 'PROJ-302', one, 3);
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-302');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('pipeline failed');
      const run = await app.get(HistoryService).findRun('PROJ-302');
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
    const read = jest.fn(async () => ({
      snapshot: shot(canceled ? 'canceled' : 'running', [job(7, 'unit', false, canceled ? 'failed' : 'in_progress')]),
      httpCalls: [call('GET')],
    }));
    const cancel = jest.fn(async () => {
      canceled = true;
      return { httpCalls: [call('POST')] };
    });
    const trace = jest.fn(async () => ({ trace: 'log 7\n', httpCalls: [call('GET')] }));
    const app = await boot(root, read, trace, 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=0\nPIPELINE_START_TIMEOUT_MS=50\n', cancel);
    try {
      await seed(app, 'PROJ-303');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-303');
      expect(result.exitCode).toBe(0);
      expect(cancel).toHaveBeenCalledWith('group/demo', 9);
      expect(result.message).toContain('pipeline failed');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-303');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsPipeline).toBe(1);
      const body = await history.latestBody('PROJ-303', 'pipeline_log');
      expect(body?.startsWith('It was still running after 0 minutes and swarmloop canceled it')).toBe(true);
      expect(body).toContain('log 7');
      const notes = await history.latestBody('PROJ-303', 'return');
      expect(notes).toContain('## pipeline');
      expect(notes).toContain('It was still running after 0 minutes and swarmloop canceled it');
      expect(notes).toContain('log 7');
    } finally {
      await app.close();
    }
  });

  it('returns to implement when canceling a timed-out run fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-cancel-fail-'));
    const read = jest.fn(async (_ref: { project: string }, jobs = true) => ({
      snapshot: shot('running', jobs ? [job(7, 'unit', false, 'in_progress')] : []),
      httpCalls: [call('GET')],
    }));
    const cancel = jest.fn(async () => {
      throw new FetchFailed('github pipeline failed: HTTP 500', [call('POST')]);
    });
    const trace = jest.fn(async () => ({ trace: 'secret trace\n', httpCalls: [call('GET')] }));
    const app = await boot(root, read, trace, 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=0\nPIPELINE_START_TIMEOUT_MS=50\n', cancel);
    try {
      await seed(app, 'PROJ-318');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-318');
      expect(result.exitCode).toBe(0);
      expect(cancel).toHaveBeenCalledWith('group/demo', 9);
      expect(read.mock.calls.map((entry) => entry[1])).toEqual([false, true]);
      expect(trace).not.toHaveBeenCalled();
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-318');
      expect(run?.currentStep).toBe('implement');
      expect(run?.attemptsPipeline).toBe(1);
      const notes = await history.latestBody('PROJ-318', 'return');
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
    const read = jest.fn(async () => {
      reads += 1;
      const status = reads === 1 ? 'running' : 'success';
      return { snapshot: shot(status, []), httpCalls: [call('GET')] };
    });
    const app = await boot(root, read, jest.fn(), 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=5000\n');
    try {
      await seed(app, 'PROJ-304');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-304');
      expect(result.exitCode).toBe(0);
      expect(read).toHaveBeenCalledTimes(2);
      expect((await app.get(HistoryService).findRun('PROJ-304'))?.currentStep).toBe('done');
      expect((await app.get(HistoryService).findRun('PROJ-304'))?.status).toBe('done');
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      await app.close();
    }
  });

  it('waits when a person still has to start a manual pipeline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-manual-'));
    const app = await boot(root, jest.fn(async () => ({ snapshot: shot('manual', []), httpCalls: [call('GET')] })), jest.fn());
    try {
      await seed(app, 'PROJ-305');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-305');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('pipeline is manual');
      expect((await app.get(HistoryService).findRun('PROJ-305'))?.attemptsPipeline).toBe(0);
    } finally {
      await app.close();
    }
  });

  it('returns a canceled pipeline to implement with and without auto', async () => {
    for (const auto of [false, true]) {
      const root = await mkdtemp(join(tmpdir(), `swarmloop-pipe-cancel-${auto}-`));
      const trace = jest.fn(async () => ({ trace: 'canceled log\n', httpCalls: [call('GET')] }));
      const app = await boot(root, jest.fn(async () => ({ snapshot: shot('canceled', [job(7, 'unit', false)]), httpCalls: [call('GET')] })), trace);
      try {
        await seed(app, 'PROJ-306');
        const result = await app.get(PipelineService).step('pipeline', 'PROJ-306', auto ? { auto: true } : {});
        expect(result.exitCode).toBe(0);
        expect(trace).toHaveBeenCalledWith('group/demo', 7);
        const history = app.get(HistoryService);
        const run = await history.findRun('PROJ-306');
        expect(run?.currentStep).toBe('implement');
        expect(run?.status).toBe('waiting');
        expect(run?.attemptsPipeline).toBe(1);
        const notes = await history.latestBody('PROJ-306', 'return');
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
    const app = await boot(root, jest.fn(async () => ({ snapshot: shot('skipped', []), httpCalls: [call('GET')] })), trace);
    try {
      await seed(app, 'PROJ-319');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-319');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('pipeline was skipped');
      expect(trace).not.toHaveBeenCalled();
      const run = await app.get(HistoryService).findRun('PROJ-319');
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
    const read = jest.fn(async (ref: { project: string }) => {
      if (ref.project === 'group/web') {
        return { snapshot: shot('running', []), httpCalls: [call('GET')] };
      }
      return { snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] };
    });
    const app = await boot(root, read, jest.fn(async () => ({ trace: 'log\n', httpCalls: [call('GET')] })), 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=5000\n');
    try {
      await seed(app, 'PROJ-308', two);
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-308');
      expect(result.exitCode).toBe(0);
      expect(read).toHaveBeenCalledTimes(2);
      const run = await app.get(HistoryService).findRun('PROJ-308');
      expect(run?.currentStep).toBe('implement');
      expect(run?.attemptsPipeline).toBe(1);
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      await app.close();
    }
  });

  it('returns to implement when a job trace cannot be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-trace-'));
    const trace = jest.fn(async () => {
      throw new FetchFailed('gitlab pipeline failed', [call('GET')]);
    });
    const app = await boot(root, jest.fn(async () => ({ snapshot: shot('failed', [job(7, 'unit', false)]), httpCalls: [call('GET')] })), trace);
    try {
      await seed(app, 'PROJ-309');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-309');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('pipeline failed');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-309');
      expect(run?.currentStep).toBe('implement');
      expect(run?.status).toBe('waiting');
      expect(run?.attemptsPipeline).toBe(1);
      const notes = await history.latestBody('PROJ-309', 'return');
      expect(notes).toContain('project: group/demo');
      expect(notes).toContain('pipeline: 9');
      expect(notes).toContain('job: unit');
      expect(notes).toContain('https://gitlab.example/group/demo/-/pipelines/9');
      expect(notes).toContain('gitlab pipeline failed');
    } finally {
      await app.close();
    }
  });

  it('waits for a run that is not registered yet', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-late-'));
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    let reads = 0;
    const read = jest.fn(async () => {
      reads += 1;
      return reads === 1
        ? { snapshot: null, httpCalls: [call('GET')] }
        : { snapshot: shot('success', []), httpCalls: [call('GET')] };
    });
    const app = await boot(root, read, jest.fn(), 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=5000\n');
    try {
      await seed(app, 'PROJ-310');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-310');
      expect(result.exitCode).toBe(0);
      expect(read).toHaveBeenCalledTimes(2);
      expect((await app.get(HistoryService).findRun('PROJ-310'))?.currentStep).toBe('done');
      expect(await app.get(HistoryService).latestBody('PROJ-310', 'pipeline_log')).toContain('result: pass');
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      await app.close();
    }
  });

  it('goes on green when the worktree has no workflow', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-none-'));
    const read = jest.fn(async () => ({ snapshot: null, httpCalls: [call('GET')] }));
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    const app = await boot(root, read, jest.fn(), 'TICK_MS=1\nPIPELINE_TIMEOUT_MS=30\n');
    try {
      await seed(app, 'PROJ-307');
      const run = await app.get(HistoryService).findRun('PROJ-307');
      await app.get(HistoryService).putDocument(run!, 'repos', 'demo\n');
      mkdirSync(join(root, 'worktrees', 'PROJ-307', 'demo'), { recursive: true });
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-307');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('nothing started');
      expect(read).toHaveBeenCalledTimes(1);
      const after = await app.get(HistoryService).findRun('PROJ-307');
      expect(after?.currentStep).toBe('done');
      expect(after?.status).toBe('done');
      expect(await app.get(HistoryService).latestBody('PROJ-307', 'pipeline_log')).toContain('result: none');
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      await app.close();
    }
  });

  it('fails when a workflow exists and no run starts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-configured-'));
    const read = jest.fn(async () => ({ snapshot: null, httpCalls: [call('GET')] }));
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    const previousStart = process.env.PIPELINE_START_TIMEOUT_MS;
    const app = await boot(root, read, jest.fn(), 'TICK_MS=1\nPIPELINE_START_TIMEOUT_MS=50\nPIPELINE_TIMEOUT_MS=1500\n');
    const started = Date.now();
    try {
      await seed(app, 'PROJ-311');
      const run = await app.get(HistoryService).findRun('PROJ-311');
      await app.get(HistoryService).putDocument(run!, 'repos', 'demo\n');
      const workflow = join(root, 'worktrees', 'PROJ-311', 'demo', '.github', 'workflows');
      mkdirSync(workflow, { recursive: true });
      await writeFile(join(workflow, 'test.yml'), 'name: Test\non: push\n');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-311');
      expect(Date.now() - started).toBeLessThan(700);
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('demo CI did not start');
      expect(read.mock.calls.length).toBeGreaterThan(1);
      const after = await app.get(HistoryService).findRun('PROJ-311');
      expect(after?.currentStep).toBe('pipeline');
      expect(after?.status).toBe('failed');
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      restore('PIPELINE_START_TIMEOUT_MS', previousStart);
      await app.close();
    }
  });

  it('follows a pipeline that appears during the start window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-appeared-'));
    let reads = 0;
    const read = jest.fn(async () => {
      reads += 1;
      return reads === 1
        ? { snapshot: null, httpCalls: [call('GET')] }
        : { snapshot: shot('success', []), httpCalls: [call('GET')] };
    });
    const app = await boot(root, read, jest.fn(), 'TICK_MS=1\nPIPELINE_START_TIMEOUT_MS=5000\nPIPELINE_TIMEOUT_MS=5000\n');
    try {
      await seed(app, 'PROJ-313');
      const run = await app.get(HistoryService).findRun('PROJ-313');
      await app.get(HistoryService).putDocument(run!, 'repos', 'demo\n');
      gitRepo(join(root, 'worktrees', 'PROJ-313', 'demo'), 'git@gitlab.example:group/demo.git');
      const workflow = join(root, 'worktrees', 'PROJ-313', 'demo', '.github', 'workflows');
      mkdirSync(workflow, { recursive: true });
      await writeFile(join(workflow, 'test.yml'), 'name: Test\non: push\n');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-313');
      expect(result.exitCode).toBe(0);
      expect(read).toHaveBeenCalledTimes(2);
      expect((await app.get(HistoryService).findRun('PROJ-313'))?.currentStep).toBe('done');
      expect(await app.get(HistoryService).latestBody('PROJ-313', 'pipeline_log')).toContain('result: pass');
    } finally {
      await app.close();
    }
  });

  it('keeps polling a running pipeline after the start window', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-running-past-start-'));
    let reads = 0;
    const read = jest.fn(async (_ref: { project: string }, _jobs?: boolean) => {
      reads += 1;
      return { snapshot: shot(reads < 4 ? 'running' : 'success', []), httpCalls: [call('GET')] };
    });
    const app = await boot(root, read, jest.fn(), 'TICK_MS=30\nPIPELINE_START_TIMEOUT_MS=40\nPIPELINE_TIMEOUT_MS=500\n');
    try {
      await seed(app, 'PROJ-314');
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-314');
      expect(result.exitCode).toBe(0);
      expect(read).toHaveBeenCalledTimes(4);
      expect(read.mock.calls.every((entry) => entry[1] === false)).toBe(true);
      expect((await app.get(HistoryService).findRun('PROJ-314'))?.currentStep).toBe('done');
    } finally {
      await app.close();
    }
  });

  it('fails when one workflow never starts and another run passed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-partial-'));
    const read = jest.fn(async (ref: { project: string }) => {
      if (ref.project === 'group/web') {
        return { snapshot: null, httpCalls: [call('GET')] };
      }
      return { snapshot: shot('success', []), httpCalls: [call('GET')] };
    });
    const previousTick = process.env.TICK_MS;
    const previousTimeout = process.env.PIPELINE_TIMEOUT_MS;
    const previousStart = process.env.PIPELINE_START_TIMEOUT_MS;
    const app = await boot(root, read, jest.fn(), 'TICK_MS=1\nPIPELINE_START_TIMEOUT_MS=800\nPIPELINE_TIMEOUT_MS=5000\n');
    try {
      await seed(app, 'PROJ-312', two);
      const run = await app.get(HistoryService).findRun('PROJ-312');
      await app.get(HistoryService).putDocument(run!, 'repos', 'demo\nweb\n');
      gitRepo(join(root, 'worktrees', 'PROJ-312', 'demo'), 'git@gitlab.example:group/demo.git');
      gitRepo(join(root, 'worktrees', 'PROJ-312', 'web'), 'git@gitlab.example:group/web.git');
      for (const name of ['demo', 'web']) {
        const workflow = join(root, 'worktrees', 'PROJ-312', name, '.github', 'workflows');
        mkdirSync(workflow, { recursive: true });
        await writeFile(join(workflow, 'test.yml'), 'name: Test\non: push\n');
      }
      const started = Date.now();
      const result = await app.get(PipelineService).step('pipeline', 'PROJ-312');
      expect(Date.now() - started).toBeLessThan(2500);
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('web CI did not start');
      expect(read.mock.calls.length).toBeGreaterThan(2);
      const after = await app.get(HistoryService).findRun('PROJ-312');
      expect(after?.currentStep).toBe('pipeline');
      expect(after?.status).toBe('failed');
    } finally {
      restore('TICK_MS', previousTick);
      restore('PIPELINE_TIMEOUT_MS', previousTimeout);
      restore('PIPELINE_START_TIMEOUT_MS', previousStart);
      await app.close();
    }
  });
});

function gitRepo(dir: string, origin: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init'], { cwd: dir });
  execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
}

const one = `project: group/demo\nref: feature/PROJ-300-ship\n`;
const two = `${one}\nproject: group/web\nref: feature/PROJ-300-ship\n`;

function shot(status: string, jobs: PipelineJob[]): PipelineSnapshot {
  return { id: 9, status, url: 'https://gitlab.example/group/demo/-/pipelines/9', jobs };
}

function job(id: number, name: string, allowFailure: boolean, status = 'failed'): PipelineJob {
  return { id, name, stage: 'test', status, allowFailure };
}

function call(method: string): HttpCallDraft {
  return {
    provider: 'gitlab',
    method,
    url: 'https://gitlab.example/api/v4/projects/group%2Fdemo/pipelines',
    statusCode: 200,
    durationMs: 1,
    error: null,
  };
}

function restore(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function boot(
  root: string,
  read: jest.Mock,
  trace: jest.Mock,
  extra = 'PIPELINE_TIMEOUT_MS=0\n',
  cancel: jest.Mock = jest.fn(async () => ({ httpCalls: [] as HttpCallDraft[] })),
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
      `GITLAB_TOKEN=${TOKEN}`,
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
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(CodeHostRegistry)
    .useFactory({
      factory: () => {
        const config = {
          getOrThrow: (key: string) => process.env[key] ?? '',
          get: (key: string) => process.env[key],
        } as ConfigService;
        const registry = CodeHostRegistry.create(config);
        jest.spyOn(registry, 'byName').mockReturnValue({
          findMergeRequest: jest.fn(),
          openMergeRequest: jest.fn(),
          readBranchPipeline: read,
          readJobTrace: trace,
          cancelPipeline: cancel,
        } as never);
        return registry;
      },
    })
    .compile();
}

async function seed(app: Awaited<ReturnType<typeof boot>>, key: string, body = one, attemptsPipeline = 0): Promise<void> {
  const history = app.get(HistoryService);
  const seeded = await history.begin(key, 'pipeline');
  seeded.status = 'waiting';
  seeded.currentStep = 'commit';
  seeded.codeHost = 'gitlab';
  seeded.attemptsPipeline = attemptsPipeline;
  await history.saveRun(seeded);
  await history.putDocument(seeded, 'pipeline_ref', body);
}
