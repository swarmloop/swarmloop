import 'reflect-metadata';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import type { PipelineSnapshot } from '../../integrations/code-host/code-host';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { PipelineService } from '../../pipeline/pipeline.service';

import { appCheck, boot, call, fakeWait, seed, shot, withChecks } from './pipeline.step.spec-helpers';

const TIMING = 'TICK_MS=15000\nPIPELINE_TIMEOUT_MS=1800000\nPIPELINE_START_TIMEOUT_MS=180000\n';
const NOTES = [
  { path: 'server/src/core/attempt-output.ts', line: 41, level: 'failure', title: 'Path expression', message: 'first' },
  {
    path: 'server/src/core/attempt-output.ts',
    line: 77,
    level: 'failure',
    title: 'Path expression',
    message: 'second',
  },
];
const SCANNING = 'Code scanning results';

/** Runs the pipeline step against a fake host that answers `answer(pollNumber)`. */
async function stepWith(key: string, answer: (poll: number) => PipelineSnapshot, extra = TIMING) {
  const clock = fakeWait();
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-pipe-checks-'));
  let polls = 0;
  const read = jest.fn(() => {
    polls += 1;
    return Promise.resolve({ snapshot: answer(polls), httpCalls: [call('GET')] });
  });
  const cancel = jest.fn(() => Promise.resolve({ httpCalls: [] }));
  const trace = jest.fn(() => Promise.resolve({ trace: 'log\n', httpCalls: [] }));
  const app = await boot(root, read, trace, extra, cancel, clock);
  try {
    await seed(app, key);
    await app.get(PipelineService).step('pipeline', key);
    const run = await app.get(RunRepository).findRun(key);
    const body = (kind: string) => app.get(DocumentRepository).latestBody(key, kind);
    return { run, read, cancel, returned: await body('return'), log: await body('pipeline_log') };
  } finally {
    await app.close();
  }
}

describe('pipeline step on every check of the commit', () => {
  afterEach(() => jest.restoreAllMocks());

  it('waits for a code scanning check that appears two minutes after ci finished', async () => {
    const result = await stepWith('PROJ-500', (poll) =>
      poll <= 8
        ? shot('success', [], [], [SCANNING])
        : withChecks('success', [appCheck({ summary: '2 alerts', annotations: NOTES })]),
    );
    expect(result.read.mock.calls.length).toBeGreaterThan(8);
    expect(result.run?.currentStep).toBe('implement');
    expect(result.returned).toContain('job: CodeQL / Code scanning results');
  });

  it('lists every annotation of a failed code scanning check in the return', async () => {
    const result = await stepWith('PROJ-501', () =>
      withChecks('success', [appCheck({ summary: '2 alerts', annotations: NOTES })]),
    );
    expect(result.returned).toContain('2 alerts');
    expect(result.returned).toContain('server/src/core/attempt-output.ts:41 failure Path expression: first');
    expect(result.returned).toContain('server/src/core/attempt-output.ts:77 failure Path expression: second');
    expect(result.run?.attemptsPipeline).toBe(1);
  });

  it('returns a red commit status of another app', async () => {
    const status = appCheck({ id: 5, name: 'deploy/preview', app: 'bot', summary: 'build broke' });
    const result = await stepWith('PROJ-502', () => withChecks('success', [status]));
    expect(result.run?.currentStep).toBe('implement');
    expect(result.returned).toContain('job: bot / deploy/preview');
    expect(result.returned).toContain('build broke');
  });

  it('ends done when every check is green', async () => {
    const result = await stepWith('PROJ-503', () => withChecks('success', [appCheck({ status: 'success' })]));
    expect(result.run?.currentStep).not.toBe('implement');
    expect(result.log).toContain('result: pass');
  });

  it('returns red when an app check never finishes, and cancels no run', async () => {
    const result = await stepWith(
      'PROJ-504',
      () => withChecks('success', [appCheck({ name: 'deploy/preview', status: 'running' })]),
      'TICK_MS=15000\nPIPELINE_TIMEOUT_MS=60000\nPIPELINE_START_TIMEOUT_MS=1000\n',
    );
    expect(result.run?.currentStep).toBe('implement');
    expect(result.returned).toContain('deploy/preview did not finish within 1 minutes');
    expect(result.cancel).not.toHaveBeenCalled();
  });

  it('ends green when the expected code scanning check never shows up', async () => {
    const result = await stepWith(
      'PROJ-505',
      () => shot('success', [], [], [SCANNING]),
      'TICK_MS=15000\nPIPELINE_TIMEOUT_MS=60000\nPIPELINE_START_TIMEOUT_MS=1000\n',
    );
    expect(result.run?.currentStep).not.toBe('implement');
    expect(result.log).toContain('result: pass');
  });
});
