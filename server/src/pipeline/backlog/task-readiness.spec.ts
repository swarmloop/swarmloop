import type { BacklogTaskRecord } from '../../history/backlog.repository';
import {
  backlogTasks,
  candidates,
  dependencyWait,
  filesWait,
  mainWait,
  mayStart,
  placeWait,
  repositoriesOf,
  type MainReading,
  type RunFacts,
} from './task-readiness';

function record(slug: string, overrides: Partial<BacklogTaskRecord> = {}): BacklogTaskRecord {
  return {
    backlogId: 1,
    milestoneId: 1,
    slug,
    title: slug,
    description: `Do ${slug}`,
    repositories: ['web'],
    covers: [],
    depends: [],
    files: [`${slug}.ts`],
    proof: ['a.spec.ts', 'b.spec.ts'],
    manual: false,
    fixesMain: null,
    status: 'waiting',
    runKey: null,
    note: '',
    runNow: false,
    mergeOk: false,
    merged: {},
    madeBy: 'person',
    position: 1,
    createdAt: '2026-11-12T10:00:00Z',
    ...overrides,
  };
}

const ACTIVE = new Set([1]);
const NO_RUNS = new Map<string, RunFacts>();
const green: MainReading = { state: 'green' };

function tasksOf(records: BacklogTaskRecord[], runs = NO_RUNS) {
  return backlogTasks(records, ACTIVE, runs);
}

describe('candidates', () => {
  it('keeps plan order and holds a task until its dependencies are merged', () => {
    const tasks = tasksOf([
      record('a'),
      record('b', { depends: ['a'] }),
      record('c'),
      record('d', { depends: ['x'], status: 'merged' }),
    ]);
    expect(candidates(tasks).map((task) => task.id)).toEqual(['a', 'c']);
    const after = tasksOf([record('a', { status: 'merged' }), record('b', { depends: ['a'] })]);
    expect(candidates(after).map((task) => task.id)).toEqual(['b']);
  });

  it('puts nothing behind a blocked task and counts a skipped one as settled', () => {
    const runs = new Map<string, RunFacts>([['a-1', { state: 'failed', currentStep: 'implement' }]]);
    const blocked = tasksOf(
      [record('a', { runKey: 'a-1' }), record('b', { depends: ['a'] }), record('c', { depends: ['b'] })],
      runs,
    );
    expect(blocked[0]?.status).toBe('blocked');
    expect(candidates(blocked)).toEqual([]);
    const skipped = tasksOf([record('a', { status: 'skipped' }), record('b', { depends: ['a'] })]);
    expect(candidates(skipped).map((task) => task.id)).toEqual(['b']);
  });

  it('takes only tasks of an active milestone or run now, and none that has a run key', () => {
    const tasks = tasksOf([
      record('active'),
      record('proposed', { milestoneId: 2 }),
      record('item', { milestoneId: null }),
      record('now', { milestoneId: null, runNow: true }),
      record('started', { runKey: 'started-1' }),
    ]);
    expect(candidates(tasks).map((task) => task.id)).toEqual(['active', 'now']);
  });

  it('leaves out a ready task that names no file', () => {
    const tasks = tasksOf([record('bare', { files: [] }), record('named')]);
    expect(candidates(tasks).map((task) => task.id)).toEqual(['named']);
  });

  it('expands a requirement a task depends on to the tasks that cover it', () => {
    const records = [
      record('a', { covers: ['M1.R1'] }),
      record('b', { covers: ['M1.R1'], status: 'merged' }),
      record('c', { depends: ['M1.R1'] }),
    ];
    expect(candidates(tasksOf(records)).map((task) => task.id)).toEqual(['a']);
    const settled = [{ ...records[0], status: 'merged' as const }, ...records.slice(1)];
    expect(candidates(tasksOf(settled)).map((task) => task.id)).toEqual(['c']);
  });

  it('shows a task with a run by that run and keeps a merged task merged', () => {
    const runs = new Map<string, RunFacts>([['a-1', { state: 'running', currentStep: 'implement' }]]);
    const [running, merged] = tasksOf(
      [record('a', { runKey: 'a-1' }), record('b', { status: 'merged', runKey: 'b-1' })],
      runs,
    );
    expect([running?.status, merged?.status]).toEqual(['running', 'merged']);
  });
});

describe('mainWait', () => {
  const tasks = tasksOf([
    record('a'),
    record('b', { repositories: ['server'] }),
    record('c', { repositories: ['web', 'server'] }),
  ]);

  it('holds a task for each repository of it that is not green, and only those', () => {
    const mains = new Map<string, MainReading>([
      ['web', { state: 'red' }],
      ['server', green],
    ]);
    expect(mainWait(tasks[0], tasks, mains)).toBe('waits for a green main of web');
    expect(mainWait(tasks[1], tasks, mains)).toBeNull();
    expect(mainWait(tasks[2], tasks, mains)).toBe('waits for a green main of web');
  });

  it('does not hold a task for a main with no CI', () => {
    const mains = new Map<string, MainReading>([
      ['web', { state: 'none' }],
      ['server', green],
    ]);
    expect(mainWait(tasks[0], tasks, mains)).toBeNull();
    expect(mainWait(tasks[2], tasks, mains)).toBeNull();
  });

  it('holds a task for a main it could not read, with the reason', () => {
    const mains = new Map<string, MainReading>([
      ['web', { state: 'unreadable', note: 'host did not answer; next try at 10:05' }],
    ]);
    expect(mainWait(tasks[0], tasks, mains)).toBe(
      'waits for a green main of web: host did not answer; next try at 10:05',
    );
  });

  it('lets a fixes_main task start on its red main and holds every other task of that repository', () => {
    const list = tasksOf([
      record('fix', { fixesMain: 'web' }),
      record('other'),
      record('apart', { repositories: ['server'] }),
    ]);
    const mains = new Map<string, MainReading>([
      ['web', { state: 'red' }],
      ['server', green],
    ]);
    expect(mainWait(list[0], list, mains)).toBeNull();
    expect(mainWait(list[1], list, mains)).toBe('waits for fix, which fixes the main of web');
    expect(mainWait(list[2], list, mains)).toBeNull();
  });

  it('stops holding for a fixes_main task once it is merged or skipped', () => {
    const list = tasksOf([record('fix', { fixesMain: 'web', status: 'merged' }), record('other')]);
    expect(mainWait(list[1], list, new Map([['web', green]]))).toBeNull();
  });
});

describe('dependencyWait', () => {
  it('says nothing for a task that waits for no one', () => {
    const [only] = tasksOf([record('a')]);
    expect(dependencyWait(only, [only])).toBeNull();
  });

  it('names the tasks a task waits for, and the blocked task behind it', () => {
    const runs = new Map<string, RunFacts>([['a-1', { state: 'failed', currentStep: 'implement' }]]);
    const list = tasksOf(
      [record('a', { runKey: 'a-1' }), record('b', { depends: ['a'] }), record('c'), record('d', { depends: ['c'] })],
      runs,
    );
    expect(dependencyWait(list[1], list)).toBe('waiting for a, which is blocked');
    expect(dependencyWait(list[3], list)).toBe('waiting for c');
  });

  it('names a requirement as its tasks, also when no task covers it yet', () => {
    const list = tasksOf([
      record('a', { covers: ['M3.R1'] }),
      record('b', { depends: ['M3.R1', 'a'] }),
      record('c', { depends: ['M3.R2'] }),
    ]);
    expect(dependencyWait(list[1], list)).toBe("waits for M3.R1's tasks");
    expect(dependencyWait(list[2], list)).toBe("waits for M3.R2's tasks");
  });
});

describe('mayStart and filesWait', () => {
  it('lets a task start in an active milestone or when run now, and in no other place', () => {
    expect(mayStart({ runNow: false, milestoneId: 1 }, ACTIVE)).toBe(true);
    expect(mayStart({ runNow: true, milestoneId: null }, ACTIVE)).toBe(true);
    expect(mayStart({ runNow: false, milestoneId: 2 }, ACTIVE)).toBe(false);
    expect(mayStart({ runNow: false, milestoneId: null }, ACTIVE)).toBe(false);
  });

  it('words the wait of a task with no file, and says nothing for one that names files', () => {
    const [bare, named] = tasksOf([record('bare', { files: [] }), record('named')]);
    expect(filesWait(bare)).toBe('waits for its files');
    expect(filesWait(named)).toBeNull();
  });
});

describe('placeWait and repositoriesOf', () => {
  it('words the wait for a free place with the count of started tasks', () => {
    expect(placeWait(3)).toBe('waits for a free place: 3 of BACKLOG_PARALLEL');
  });

  it('lists each repository of the tasks once', () => {
    const list = tasksOf([record('a'), record('b', { repositories: ['web', 'server'] })]);
    expect(repositoriesOf(list)).toEqual(['web', 'server']);
  });
});

describe('requirement cycles', () => {
  const a = record('a', { covers: ['M1.R1'], depends: ['M1.R2'] });
  const b = record('b', { covers: ['M1.R2'], depends: ['M1.R1'] });

  it('does not make a task wait for the requirement it covers itself', () => {
    const tasks = tasksOf([record('a', { covers: ['M1.R1'], depends: ['M1.R1'] })]);
    expect(tasks[0].depends).toEqual([]);
    expect(candidates(tasks).map((task) => task.id)).toEqual(['a']);
  });

  it('names a stored cycle on each of its tasks and starts none of them', () => {
    const tasks = tasksOf([a, b]);
    expect(dependencyWait(tasks[0], tasks)).toBe('waits in a cycle: a -> M1.R2 (b) -> M1.R1 (a)');
    expect(dependencyWait(tasks[1], tasks)).toBe('waits in a cycle: b -> M1.R1 (a) -> M1.R2 (b)');
    expect(candidates(tasks)).toEqual([]);
  });

  it('keeps a task waiting for a requirement that no task covers', () => {
    const tasks = tasksOf([record('a', { depends: ['M1.R3'] })]);
    expect(dependencyWait(tasks[0], tasks)).toBe("waits for M1.R3's tasks");
  });
});

describe('the hold for the planner to read a merge', () => {
  const merged = record('a', { status: 'merged' });
  const records = [merged, record('b', { depends: ['a'] }), record('c')];

  it('holds a dependent of a merged task whose merge event is unread, and no other task', () => {
    const tasks = backlogTasks(records, ACTIVE, NO_RUNS, new Set(['a']));
    expect(candidates(tasks).map((task) => task.id)).toEqual(['c']);
    expect(dependencyWait(tasks[1], tasks)).toBe('waits for the planner to read the merge of a');
    expect(dependencyWait(tasks[2], tasks)).toBeNull();
  });

  it('holds nothing for a merged task with no unread merge event', () => {
    const tasks = backlogTasks(records, ACTIVE, NO_RUNS);
    expect(candidates(tasks).map((task) => task.id)).toEqual(['b', 'c']);
    expect(dependencyWait(tasks[1], tasks)).toBeNull();
  });

  it('holds a task that depends on the merged task through a requirement it covers', () => {
    const covered = [record('a', { status: 'merged', covers: ['M1.R1'] }), record('b', { depends: ['M1.R1'] })];
    const tasks = backlogTasks(covered, ACTIVE, NO_RUNS, new Set(['a']));
    expect(candidates(tasks)).toEqual([]);
  });
});
