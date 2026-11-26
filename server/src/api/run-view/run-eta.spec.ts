import { WAITS_FOR_YOU } from '../../contract/eta';
import type { Subtask } from '../../contract/subtask';
import { emptyTable, MIN, NOW } from '../../eta/eta.spec-helpers';
import type { RunEntity } from '../../history/entities';
import { liveRunOf, runViewEta, taskEtas } from './run-eta';

const now = Date.parse(NOW);

const runEntity = (extra: Partial<RunEntity> = {}): RunEntity =>
  ({ parentRunId: null, epicAt: null, currentStep: 'implement', stepStartedAt: null, ...extra }) as RunEntity;

const task = (id: string, depends: string[] = []): Subtask => ({
  id,
  title: id,
  description: '',
  depends,
  files: [],
  proof: '',
  status: 'waiting',
});

describe('run view eta', () => {
  it('reads the kind of a run from its parent and its epic time', () => {
    const own = { state: 'running', stateReason: null } as const;
    expect(liveRunOf(runEntity(), own, []).kind).toBe('plain');
    expect(liveRunOf(runEntity({ epicAt: NOW }), own, []).kind).toBe('epic');
    expect(liveRunOf(runEntity({ parentRunId: 3 }), own, []).kind).toBe('subtask');
  });

  it('gives the header, the list and the Tasks rows one estimate, and a task not started the whole-subtask median', () => {
    const table = emptyTable();
    table.subtask = { steps: { implement: 20 * MIN }, visits: {}, whole: 50 * MIN };
    table.epic = { steps: {}, visits: {}, whole: null };
    const own = { state: 'running', stateReason: null } as const;
    const plan = [task('a'), task('b', ['a'])];
    const first = liveRunOf(runEntity({ parentRunId: 1, currentStep: 'implement' }), own, []);
    const lives = new Map([['a', first]]);
    const parent = liveRunOf(runEntity({ epicAt: NOW, currentStep: 'research' }), own, []);

    const etas = taskEtas(plan, lives, table, now);
    expect(etas.get('a')?.leftMs).toBe(20 * MIN);
    expect(etas.get('b')?.leftMs).toBe(50 * MIN);

    const whole = runViewEta(parent, plan, lives, table, 3, now);
    const chain = (etas.get('a')?.leftMs ?? 0) + (etas.get('b')?.leftMs ?? 0);
    expect(whole?.leftMs).toBeGreaterThanOrEqual(chain);
    expect(runViewEta(parent, undefined, new Map(), table, 3, now)?.leftMs).toBeGreaterThan(0);
  });

  it('counts the visits of a relaunched task run only, in the task rows and the epic', () => {
    const table = emptyTable();
    table.subtask = { steps: { implement: 90 * MIN }, visits: { checks: 5 * MIN, pipeline: 10 * MIN }, whole: null };
    const own = { state: 'running', stateReason: null } as const;
    const run = runEntity({ parentRunId: 1, currentStep: 'checks' });
    const relaunched = liveRunOf(run, own, [], ['checks', 'pipeline']);
    expect(relaunched.relaunch).toEqual(['checks', 'pipeline']);
    expect(liveRunOf(run, own, []).relaunch).toBeUndefined();
    const plan = [task('a')];
    expect(taskEtas(plan, new Map([['a', relaunched]]), table, now).get('a')?.leftMs).toBe(15 * MIN);
  });

  it('gives a task whose run waits for a person none, and the epic none', () => {
    const asking = liveRunOf(
      runEntity({ parentRunId: 1 }),
      { state: 'waiting', stateReason: { code: 'NEEDS_ANSWERS' } as never },
      [],
    );
    const plan = [task('a')];
    const lives = new Map([['a', asking]]);
    const parent = liveRunOf(runEntity({ epicAt: NOW }), { state: 'running', stateReason: null }, []);
    expect(taskEtas(plan, lives, emptyTable(), now).get('a')).toEqual(WAITS_FOR_YOU);
    expect(runViewEta(parent, plan, lives, emptyTable(), 3, now)).toEqual(WAITS_FOR_YOU);
  });

  it('makes an epic wait for you when one task is blocked while another still works', () => {
    const parent = liveRunOf(
      runEntity({ epicAt: NOW }),
      { state: 'waiting', stateReason: { code: 'SUBTASKS_RUNNING' } as never },
      [],
    );
    const working = liveRunOf(runEntity({ parentRunId: 1 }), { state: 'running', stateReason: null }, []);
    const stuck = liveRunOf(
      runEntity({ parentRunId: 1 }),
      { state: 'blocked', stateReason: { code: 'NEEDS_ANSWERS' } as never },
      [],
    );
    const plan = [task('a'), task('b')];

    expect(
      runViewEta(
        parent,
        plan,
        new Map([
          ['a', stuck],
          ['b', working],
        ]),
        emptyTable(),
        3,
        now,
      ),
    ).toEqual(WAITS_FOR_YOU);
  });
});
