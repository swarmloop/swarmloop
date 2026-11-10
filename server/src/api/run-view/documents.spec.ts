import type { DocumentEntity } from '../../history/entities';
import { belongsToVisit, taskLayers } from './documents';

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
          { id: 'a', title: 'A', files: ['a.ts'], proof: 'a.spec.ts' },
          { id: 'c', title: 'C', files: ['c.ts'], proof: 'c.spec.ts' },
        ],
      },
      { layer: 1, tasks: [{ id: 'b', title: 'B', files: ['b.ts'], proof: 'b.spec.ts' }] },
      { layer: 2, tasks: [{ id: 'd', title: 'D', files: ['d.ts'], proof: 'd.spec.ts' }] },
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
