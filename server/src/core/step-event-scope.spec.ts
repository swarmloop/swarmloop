import type { StepEvent } from '../contract/step-events';
import { FakeClock } from './fake-clock.spec-helpers';
import { recordStepEvent, runInStepScope, startCommandSpan } from './step-event-scope';

function scope(runId: number, events: StepEvent[]) {
  return {
    runId,
    attemptId: `attempt-${runId}`,
    step: 'commit' as const,
    root: '/srv/root',
    clock: new FakeClock(),
    sink: (event: StepEvent) => {
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

  it('numbers the events of a scope after the last one and stamps the scope on them', async () => {
    const events: StepEvent[] = [];
    await runInStepScope(scope(7, events), 4, () => {
      recordStepEvent({ kind: 'attempt.finished', route: 'ok', summary: 'one' });
      recordStepEvent({ kind: 'attempt.finished', route: 'ok', summary: 'two' });
      return Promise.resolve();
    });
    expect(events.map(({ seq, runId, attemptId, step }) => ({ seq, runId, attemptId, step }))).toEqual([
      { seq: 5, runId: 7, attemptId: 'attempt-7', step: 'commit' },
      { seq: 6, runId: 7, attemptId: 'attempt-7', step: 'commit' },
    ]);
  });

  it('records a command with its cwd relative to the root, and what ended it', async () => {
    const events: StepEvent[] = [];
    await runInStepScope(scope(1, events), 0, () => {
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

  it('keeps the events of two scopes that run at once apart', async () => {
    const first: StepEvent[] = [];
    const second: StepEvent[] = [];
    const pause = () => new Promise((resolve) => setImmediate(resolve));
    const run = (runId: number, events: StepEvent[]) =>
      runInStepScope(scope(runId, events), 0, async () => {
        for (let index = 0; index < 3; index += 1) {
          recordStepEvent({ kind: 'attempt.finished', route: 'ok', summary: `${runId}` });
          await pause();
        }
      });
    await Promise.all([run(1, first), run(2, second)]);
    expect(first.map(({ runId, seq }) => [runId, seq])).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
    expect(second.map(({ runId, seq }) => [runId, seq])).toEqual([
      [2, 1],
      [2, 2],
      [2, 3],
    ]);
  });
});
