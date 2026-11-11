import type { DocumentEntity } from '../../history/entities';
import { belongsToVisit, taskLayers, taskLine } from './documents';

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
    expect(taskLine([approved, tasks], 'implement')).toBe('1/3 merged · 1 running · 1 waiting');
    expect(taskLine([approved, tasks], 'checks')).toBe('1/3 merged · 1 running · 1 waiting');
  });

  it('says nothing before implement, or for a run without tasks', () => {
    expect(taskLine([approved, tasks], 'plan-improve')).toBeNull();
    expect(taskLine([approved], 'implement')).toBeNull();
  });
});
