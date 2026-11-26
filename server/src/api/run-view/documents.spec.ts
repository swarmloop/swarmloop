import type { DocumentEntity } from '../../history/entities';
import {
  belongsToVisit,
  decisionsOf,
  interruptionOf,
  taskEntries,
  taskLine,
  taskView,
  documentView,
  withoutServerRecords,
  type TaskRuns,
} from './documents';

describe('belongsToVisit', () => {
  const kinds = ['return', 'issues'];

  it('shows a document of the visit', () => {
    expect(belongsToVisit({ stepStatId: 2, kind: 'return' } as DocumentEntity, 2, kinds, true)).toBe(true);
  });

  it('leaves the issues document out, even when its kind is asked for', () => {
    expect(belongsToVisit({ stepStatId: 2, kind: 'issues' } as DocumentEntity, 2, kinds, true)).toBe(true);
  });
});

describe('taskEntries', () => {
  const doc = (kind: string, body: string) => ({ kind, body }) as DocumentEntity;
  const task = (id: string, depends: string[]) => ({
    id,
    title: id.toUpperCase(),
    description: '',
    depends,
    files: [`${id}.ts`],
    proof: `${id}.spec.ts`,
    status: 'pending',
  });
  const approved = doc('requirements', JSON.stringify({ plan: { items: ['x'], decision: 'approve' } }));

  it('lists the tasks flat in plan order, each waiting task with the titles it waits for', () => {
    const tasks = doc(
      'subtasks',
      JSON.stringify([
        task('a', []),
        task('b', ['a']),
        task('c', []),
        task('d', ['b', 'c', 'gone']),
        { ...task('e', ['a']), status: 'merged' },
      ]),
    );
    const entries = taskEntries([approved, tasks]);
    expect(entries.map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(entries.map((entry) => entry.index)).toEqual([0, 1, 2, 3, 4]);
    expect(entries.map((entry) => entry.waitsFor)).toEqual([[], ['A'], [], ['B', 'C', 'gone'], undefined]);
    expect(entries[0]).not.toHaveProperty('layer');
  });

  it('shows the wait of a running task from its own run, and not a stored wait once the run goes on', () => {
    const tasks = doc('subtasks', JSON.stringify([{ ...task('c', []), status: 'running', note: 'c waits for a: x' }]));
    const run = { key: 'p-1-c', state: 'waiting' as const, currentStep: 'implement', usd: 0, durationMs: 0 };
    const waits = { ...run, stateReason: { code: 'SUBTASK_WAITING', message: 'waiting for a: x' } };
    expect(taskEntries([approved, tasks], new Map([['c', waits]]))[0]?.note).toBe('c waits for a: x');
    expect(
      taskEntries([approved, tasks], new Map([['c', { ...run, state: 'running' as const }]]))[0]?.note,
    ).toBeUndefined();
  });

  it.each([
    'c asks its own planner: which format?',
    'c asks the planner of the parent: hands back: cache',
    'c waits for the agent limit; next try at noon',
  ])('hides a stored wait after resumption: %s', (note) => {
    const tasks = doc('subtasks', JSON.stringify([{ ...task('c', []), status: 'running', note }]));
    const run = { key: 'p-1-c', state: 'running' as const, currentStep: 'implement', usd: 0, durationMs: 0 };
    expect(taskEntries([approved, tasks], new Map([['c', run]]))[0]?.note).toBeUndefined();
  });

  it('keeps an ordinary stored delivery note when the child resumes', () => {
    const note = 'rebased onto the epic';
    const tasks = doc('subtasks', JSON.stringify([{ ...task('c', []), status: 'running', note }]));
    const run = { key: 'p-1-c', state: 'running' as const, currentStep: 'implement', usd: 0, durationMs: 0 };
    expect(taskEntries([approved, tasks], new Map([['c', run]]))[0]?.note).toBe(note);
  });

  it('gives a running task no waitsFor, and a task whose dependencies merged an empty one', () => {
    const tasks = doc(
      'subtasks',
      JSON.stringify([{ ...task('a', []), status: 'merged' }, task('b', ['a']), task('c', [])]),
    );
    const run = { key: 'p-1-c', state: 'running' as const, currentStep: 'implement', usd: 0, durationMs: 0 };
    const entries = taskEntries([approved, tasks], new Map([['c', run]]));
    expect(entries.map((entry) => entry.waitsFor)).toEqual([undefined, [], undefined]);
  });

  it('shows nothing before plan-improve approved the plan, or without tasks', () => {
    const tasks = doc('subtasks', JSON.stringify([task('a', [])]));
    const unapproved = doc('requirements', JSON.stringify({ plan: { items: ['x'], decision: null } }));
    expect(taskEntries([unapproved, tasks])).toEqual([]);
    expect(taskEntries([approved, doc('subtasks', '[]\n')])).toEqual([]);
    expect(taskEntries([approved])).toEqual([]);
  });
});

describe('taskLine', () => {
  const doc = (kind: string, body: string) => ({ kind, body }) as DocumentEntity;
  const task = (id: string, status: string) => ({
    id,
    title: id,
    description: '',
    depends: [],
    files: [],
    proof: '',
    status,
  });
  const approved = doc('requirements', JSON.stringify({ plan: { items: ['x'], decision: 'approve' } }));
  const tasks = doc('subtasks', JSON.stringify([task('a', 'merged'), task('b', 'running'), task('c', 'waiting')]));

  it('sums the tasks up once the run is at implement', () => {
    expect(taskLine([approved, tasks], 'implement')).toBe('Split: 3 tasks · 1 merged · 1 running');
    expect(taskLine([approved, tasks], 'checks')).toBe('Split: 3 tasks · 1 merged · 1 running');
  });

  it('says nothing before implement, or for a run without tasks', () => {
    expect(taskLine([approved, tasks], 'plan-improve')).toBeNull();
    expect(taskLine([approved], 'implement')).toBeNull();
  });
});

describe('decisionsOf', () => {
  const tasks = [{ id: 'a', title: 'Store times' }] as Parameters<typeof decisionsOf>[1];
  const contract =
    'api:\n- r1 (owner a): GET /x\n\ndecisions:\n- subtask a at 2026-11-21T08:18:04.107Z: r1: store UTC\n  in the column\n- the plan keeps one table\n- subtask zz: unknown task\n\nrisks:\n- none\n';

  it('gives the task title, time, words, task id and item id of each entry', () => {
    expect(decisionsOf(contract, tasks)[0]).toEqual({
      task: 'Store times',
      at: '2026-11-21T08:18:04.107Z',
      text: 'store UTC\nin the column',
      taskId: 'a',
      item: 'r1',
    });
  });

  it('says Plan for a line with no task, a null time and no item, and the task id for an unknown title', () => {
    const [, plan, unknown] = decisionsOf(contract, tasks);
    expect(plan).toEqual({ task: 'Plan', at: null, text: 'the plan keeps one table', taskId: '', item: null });
    expect(unknown).toMatchObject({ task: 'zz', taskId: 'zz', text: 'unknown task' });
  });

  it('is empty without a decisions: block or without entries', () => {
    expect(decisionsOf(null, tasks)).toEqual([]);
    expect(decisionsOf('api:\n- GET /x\n', tasks)).toEqual([]);
    expect(decisionsOf('decisions:\n', tasks)).toEqual([]);
  });
});

describe('taskView', () => {
  const doc = (kind: string, body: string) => ({ kind, body }) as DocumentEntity;
  const task = (id: string, status: string) => ({
    id,
    title: id.toUpperCase(),
    description: '',
    depends: [],
    files: [],
    proof: '',
    status,
  });
  const approved = doc('requirements', JSON.stringify({ plan: { items: ['x'], decision: 'approve' } }));

  it('adds the own run of a task, the merge queue in plan order and the decisions', () => {
    const subtasks = doc('subtasks', JSON.stringify([task('a', 'green'), task('b', 'running'), task('c', 'green')]));
    const contract = doc('contract', 'decisions:\n- subtask b: store UTC\n');
    const run: TaskRuns extends Map<string, infer R> ? R : never = {
      key: 'p-1-b',
      state: 'running',
      currentStep: 'implement',
      usd: 0.5,
      durationMs: 1000,
    };
    const green = (key: string): typeof run => ({ ...run, key, state: 'done' });

    const view = taskView(
      [approved, subtasks, contract],
      'implement',
      new Map([
        ['a', green('p-1-a')],
        ['b', run],
        ['c', green('p-1-c')],
      ]),
    );

    expect(view.tasks?.map((item) => item.run)).toEqual([green('p-1-a'), run, green('p-1-c')]);
    expect(view.mergeQueue).toEqual([
      { id: 'a', title: 'A' },
      { id: 'c', title: 'C' },
    ]);
    expect(view.decisions).toEqual([{ task: 'B', at: null, text: 'store UTC', taskId: 'b', item: null }]);
  });

  it('leaves the merge queue and the decisions out when there are none', () => {
    const view = taskView([approved, doc('subtasks', JSON.stringify([task('a', 'running')]))], 'implement');

    expect(view).not.toHaveProperty('mergeQueue');
    expect(view).not.toHaveProperty('decisions');
  });

  it('shows the own state of the run, not the stored copy', () => {
    const run = { key: 'p-1-a', state: 'running' as const, currentStep: 'implement', usd: 0, durationMs: 0 };
    const subtasks = doc('subtasks', JSON.stringify([task('a', 'blocked'), task('b', 'merged'), task('c', 'running')]));

    const view = taskView([approved, subtasks], 'implement', new Map([['a', run]]));

    expect(view.tasks?.map((item) => item.status)).toEqual(['running', 'merged', 'waiting']);
  });

  it('reads a task the parent merged as merged, and lists a done run with no outcome in the merge queue', () => {
    const run = { key: 'p-1-a', currentStep: 'commit', usd: 0, durationMs: 0 };
    const subtasks = doc('subtasks', JSON.stringify([task('a', 'running'), task('b', 'merged')]));

    const view = taskView(
      [approved, subtasks],
      'implement',
      new Map([
        ['a', { ...run, state: 'done' as const }],
        ['b', { ...run, key: 'p-1-b', state: 'merged' as const }],
      ]),
    );

    expect(view.mergeQueue).toEqual([{ id: 'a', title: 'A' }]);
    expect(view.tasks?.map((item) => item.status)).toEqual(['green', 'merged']);
  });

  it('lists the merge queue in plan order, not dependency order', () => {
    const plan = [{ ...task('c', 'green'), depends: ['a'] }, task('d', 'green'), task('a', 'merged')];
    const run = { key: 'p-1-x', currentStep: 'done', usd: 0, durationMs: 0 };
    const runs: TaskRuns = new Map([
      ['c', { ...run, state: 'done' }],
      ['d', { ...run, state: 'done' }],
    ]);

    const view = taskView([approved, doc('subtasks', JSON.stringify(plan))], 'implement', runs);

    expect(view.mergeQueue?.map((item) => item.id)).toEqual(['c', 'd']);
  });
});

describe('withoutServerRecords', () => {
  const doc = (kind: string) => ({ kind }) as DocumentEntity;

  it('leaves out the stored result objects and the answer errors, and keeps the rendered documents', () => {
    const kept = [doc('plan'), doc('review_quality'), doc('implementation')];
    const records = [doc('plan_result'), doc('review_quality_result'), doc('answer_errors')];
    expect(withoutServerRecords([...kept, ...records])).toEqual(kept);
  });

  it('leaves out the plan chat', () => {
    expect(withoutServerRecords([doc('plan_chat'), doc('plan')])).toEqual([doc('plan')]);
  });

  it('leaves out an interruption note and keeps an error document', () => {
    expect(withoutServerRecords([doc('interruption'), doc('error')])).toEqual([doc('error')]);
  });
});

describe('interruptionOf', () => {
  const note = (stepStatId: number, kind: string, at: string) =>
    ({ kind, stepStatId, body: JSON.stringify({ at, relaunched: true }) }) as DocumentEntity;

  it('returns the note of the given visit only', () => {
    const documents = [
      note(2, 'interruption', 'two'),
      note(2, 'error', 'other kind'),
      note(3, 'interruption', 'three'),
    ];
    expect(interruptionOf(documents, 2)).toEqual({ at: 'two', relaunched: true });
    expect(interruptionOf(documents, 4)).toBeNull();
  });
});

describe('documentView', () => {
  const doc = (kind: string, body: string) => ({ kind, body, attempt: 1, createdAt: 'now' }) as DocumentEntity;

  it('shows a JSON handoff as ## <step> text', () => {
    const body = JSON.stringify([{ step: 'plan', body: '- a' }]);
    expect(documentView(doc('handoff', body)).body).toBe('## plan\n- a\n');
  });

  it('shows a Markdown handoff as stored and leaves other kinds untouched', () => {
    expect(documentView(doc('handoff', '## plan\n- a\n')).body).toBe('## plan\n- a\n');
    expect(documentView(doc('plan', '[{"step":"x","body":"y"}]')).body).toBe('[{"step":"x","body":"y"}]');
  });
});
