import type { StepEventDraft } from '../contract/step-events';
import { enteredBefore } from './entered-marks';
import { FakeClock } from './fake-clock.spec-helpers';
import { recordStepEvent, runInStepScope, startCommandSpan } from './step-event-scope';

function scope(runId: number, events: StepEventDraft[]) {
  return {
    runId,
    attemptId: `attempt-${runId}`,
    step: 'commit' as const,
    root: '/srv/root',
    clock: new FakeClock(),
    sink: (event: StepEventDraft) => {
      events.push(event);
      return Promise.resolve();
    },
  };
}

describe('step event scope', () => {
  it('records nothing outside a scope', () => {
    expect(() => recordStepEvent({ kind: 'attempt.finished', route: 'ok', summary: 'done' })).not.toThrow();
    expect(() =>
      startCommandSpan({ actor: 'server', repo: '', cwd: '/', executable: 'git', args: [] })({ exitCode: 0 }),
    ).not.toThrow();
  });

  it('marks the step it runs as the last entered callback', async () => {
    await runInStepScope(scope(8, []), () => Promise.resolve());
    expect(enteredBefore(Date.now())).toBe('step commit');
  });

  it('stamps the scope on its events and hands them to the sink in recording order, without a seq', async () => {
    const events: StepEventDraft[] = [];
    await runInStepScope(scope(7, events), () => {
      recordStepEvent({ kind: 'attempt.finished', route: 'ok', summary: 'one' });
      recordStepEvent({ kind: 'attempt.finished', route: 'ok', summary: 'two' });
      return Promise.resolve();
    });
    expect(events).toMatchObject([
      { summary: 'one', runId: 7, attemptId: 'attempt-7', step: 'commit' },
      { summary: 'two', runId: 7, attemptId: 'attempt-7', step: 'commit' },
    ]);
    expect(events.some((event) => 'seq' in event)).toBe(false);
  });

  it('records a command with its cwd relative to the root, and what ended it', async () => {
    const events: StepEventDraft[] = [];
    await runInStepScope(scope(1, events), () => {
      const timedOut = startCommandSpan({
        actor: 'server',
        repo: 'demo',
        cwd: '/srv/root/worktrees/demo',
        executable: 'git',
        args: ['fetch'],
      });
      timedOut({ exitCode: null, signal: 'SIGTERM', timedOut: true });
      const cancelled = startCommandSpan({
        actor: 'agent',
        repo: 'demo',
        cwd: '/srv/root',
        executable: 'agent',
        args: [],
      });
      cancelled({ exitCode: null, signal: 'SIGKILL', cancelled: true, output: 'killed\n' });
      return Promise.resolve();
    });
    expect(events.map((event) => event.kind)).toEqual([
      'command.started',
      'command.finished',
      'command.started',
      'command.finished',
    ]);
    expect(events[0]).toMatchObject({ cwd: 'worktrees/demo', executable: 'git', args: ['fetch'] });
    expect(events[1]).toMatchObject({
      exitCode: null,
      signal: 'SIGTERM',
      timedOut: true,
      cancelled: false,
      output: null,
    });
    expect(events[2]).toMatchObject({ cwd: '.', actor: 'agent' });
    expect(events[3]).toMatchObject({ signal: 'SIGKILL', timedOut: false, cancelled: true, output: 'killed' });
    expect(events[1]).toMatchObject({ spanId: (events[0] as { spanId: string }).spanId });
  });

  it('keeps a whole output and names no omitted lines when the command printed no more', async () => {
    const events: StepEventDraft[] = [];
    const output = Array.from({ length: 100 }, (_, index) => `line ${index}`).join('\n');
    await runInStepScope(scope(1, events), () => {
      startCommandSpan({ actor: 'server', repo: 'demo', cwd: '/srv/root', executable: 'npm', args: ['test'] })({
        exitCode: 1,
        output,
        outputLines: 100,
      });
      return Promise.resolve();
    });
    const finished = events[1] as { output: string };
    expect(finished.output.split('\n')).toHaveLength(100);
    expect(events[1]).not.toHaveProperty('omittedLines');
  });

  it('names the lines a command printed that its output does not hold', async () => {
    const events: StepEventDraft[] = [];
    const output = Array.from({ length: 200 }, (_, index) => `line ${index}`).join('\n');
    await runInStepScope(scope(1, events), () => {
      startCommandSpan({ actor: 'server', repo: 'demo', cwd: '/srv/root', executable: 'npm', args: ['test'] })({
        exitCode: 1,
        output,
        outputLines: 500,
      });
      return Promise.resolve();
    });
    expect((events[1] as { output: string }).output.split('\n')).toHaveLength(200);
    expect(events[1]).toMatchObject({ omittedLines: 300 });
  });

  it('keeps no output of a successful read-only git command', async () => {
    const events: StepEventDraft[] = [];
    await runInStepScope(scope(1, events), () => {
      startCommandSpan({ actor: 'server', repo: 'demo', cwd: '/srv/root', executable: 'git', args: ['status'] })({
        exitCode: 0,
        output: 'M a.ts\nM b.ts',
        outputLines: 2,
      });
      return Promise.resolve();
    });
    expect(events[1]).toMatchObject({ output: null });
    expect(events[1]).not.toHaveProperty('omittedLines');
  });

  it('marks an exit that the call declared as an answer, and no other', async () => {
    const events: StepEventDraft[] = [];
    await runInStepScope(scope(1, events), () => {
      const spec = { actor: 'server' as const, repo: 'demo', cwd: '/srv/root', executable: 'git', args: ['fetch'] };
      startCommandSpan({ ...spec, answers: [1] })({ exitCode: 1, output: 'no\n' });
      startCommandSpan({ ...spec, answers: [1] })({ exitCode: 2 });
      startCommandSpan(spec)({ exitCode: 1 });
      startCommandSpan({ ...spec, answers: [1] })({ exitCode: 0 });
      return Promise.resolve();
    });
    const ended = events.filter((event) => event.kind === 'command.finished');
    expect(ended.map((event) => ('answer' in event ? event.answer : undefined))).toEqual([
      true,
      undefined,
      undefined,
      undefined,
    ]);
  });

  it('keeps the events of two scopes that run at once apart', async () => {
    const first: StepEventDraft[] = [];
    const second: StepEventDraft[] = [];
    const pause = () => new Promise((resolve) => setImmediate(resolve));
    const run = (runId: number, events: StepEventDraft[]) =>
      runInStepScope(scope(runId, events), async () => {
        for (let index = 0; index < 3; index += 1) {
          recordStepEvent({ kind: 'attempt.finished', route: 'ok', summary: `${runId}` });
          await pause();
        }
      });
    await Promise.all([run(1, first), run(2, second)]);
    expect(first.map(({ runId }) => runId)).toEqual([1, 1, 1]);
    expect(second.map(({ runId }) => runId)).toEqual([2, 2, 2]);
  });
});
