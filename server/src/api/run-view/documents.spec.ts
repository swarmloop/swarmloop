import type { DocumentEntity } from '../../history/entities';
import { belongsToVisit, decisionsOf, taskLayers, taskLine, taskView } from './documents';

describe('belongsToVisit', () => {
  const kinds = ['return', 'issues'];

  it('shows a document of the visit', () => {
    expect(belongsToVisit({ stepStatId: 2, kind: 'return' } as DocumentEntity, 2, kinds, true)).toBe(true);
  });

  it('leaves the issues document out, even when its kind is asked for', () => {
    expect(belongsToVisit({ stepStatId: 2, kind: 'issues' } as DocumentEntity, 2, kinds, true)).toBe(true);
  });
});

describe('taskLayers', () => {
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

  it('layers by dependency', () => {
    const tasks = doc(
      'subtasks',
      JSON.stringify([task('a', []), task('b', ['a']), task('c', []), task('d', ['b', 'c'])]),
    );
    expect(taskLayers([approved, tasks])).toEqual([
      {
        layer: 0,
        tasks: [
          { id: 'a', title: 'A', files: ['a.ts'], proof: 'a.spec.ts', status: 'waiting' },
          { id: 'c', title: 'C', files: ['c.ts'], proof: 'c.spec.ts', status: 'waiting' },
        ],
      },
      { layer: 1, tasks: [{ id: 'b', title: 'B', files: ['b.ts'], proof: 'b.spec.ts', status: 'waiting' }] },
      { layer: 2, tasks: [{ id: 'd', title: 'D', files: ['d.ts'], proof: 'd.spec.ts', status: 'waiting' }] },
    ]);
  });

  it('shows nothing before plan-improve approved the plan, or without tasks', () => {
    const tasks = doc('subtasks', JSON.stringify([task('a', [])]));
    const unapproved = doc('requirements', JSON.stringify({ plan: { items: ['x'], decision: null } }));
    expect(taskLayers([unapproved, tasks])).toEqual([]);
    expect(taskLayers([approved, doc('subtasks', '[]\n')])).toEqual([]);
    expect(taskLayers([approved])).toEqual([]);
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
  it('gives the entries under decisions:, up to the next heading', () => {
    expect(
      decisionsOf('api:\n- GET /x\n\ndecisions:\n- subtask a: store UTC\n  in the column\n\nrisks:\n- none\n'),
    ).toBe('- subtask a: store UTC\n  in the column');
  });

  it('is empty without a decisions: block or without entries', () => {
    expect(decisionsOf(null)).toBeNull();
    expect(decisionsOf('api:\n- GET /x\n')).toBeNull();
    expect(decisionsOf('decisions:\n')).toBeNull();
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
    const run = { key: 'p-1-b', currentStep: 'implement', usd: 0.5, durationMs: 1000 };

    const view = taskView([approved, subtasks, contract], 'implement', new Map([['b', run]]));

    expect(view.tasks?.[0]?.tasks.map((item) => item.run)).toEqual([undefined, run, undefined]);
    expect(view.mergeQueue).toEqual([
      { id: 'a', title: 'A' },
      { id: 'c', title: 'C' },
    ]);
    expect(view.decisions).toBe('- subtask b: store UTC');
  });

  it('leaves the merge queue and the decisions out when there are none', () => {
    const view = taskView([approved, doc('subtasks', JSON.stringify([task('a', 'running')]))], 'implement');

    expect(view).not.toHaveProperty('mergeQueue');
    expect(view).not.toHaveProperty('decisions');
  });
});
