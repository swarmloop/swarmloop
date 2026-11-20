import type { Subtask } from '../../contract/subtask';
import type { SplitFields } from '../../agent-result/definitions/split-fields';
import { buildGraph } from '../plan/plan-tasks';
import { addedTasksErrors, keepStored } from './plan-improve-tasks';

const task = (id: string, status: Subtask['status'], extra: Partial<Subtask> = {}): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`${id}.ts`],
  proof: `${id}.spec.ts`,
  status,
  ...extra,
});

const CONTRACT = 'decisions:\n- the field is called `split`\n- subtask a: store UTC\n  in every table';

function answer(
  tasks: Subtask[],
  contract = ['decisions:\n- the field is called `split`\n- subtask a: store UTC\n  in every table'],
): SplitFields {
  return {
    contract: contract.map((text) => ({ id: '', text, owner: '' })),
    keep: [],
    tasks: tasks.map(({ status: _status, ...rest }) => rest),
  };
}

describe('addedTasksErrors', () => {
  const stored = [task('a', 'merged', { merged: { demo: 'abc' } }), task('b', 'running'), task('c', 'pending')];

  it('has none when the started tasks and the contract stay and a task is added', () => {
    expect(addedTasksErrors(stored, CONTRACT, answer([...stored, task('d', 'pending')]))).toEqual([]);
  });

  it('refuses a dropped started or merged task, in plain words', () => {
    const errors = addedTasksErrors(stored, CONTRACT, answer([stored[1], stored[2]]));
    expect(errors).toEqual(['task a already started and cannot be removed: keep it as it is']);
    expect(addedTasksErrors(stored, CONTRACT, answer([]))).toHaveLength(2);
  });

  it('refuses a started task whose title, description, files, proof or dependencies changed', () => {
    const changed = {
      ...stored[1],
      title: 'New',
      description: 'Other.',
      files: ['x.ts'],
      proof: 'x.spec.ts',
      depends: ['a'],
    };
    expect(addedTasksErrors(stored, CONTRACT, answer([stored[0], changed, stored[2]]))).toEqual([
      'task b already started and cannot be changed (title, description, files, proof, dependencies)',
    ]);
  });

  it('lets a task that did not start change or go', () => {
    expect(addedTasksErrors(stored, CONTRACT, answer([stored[0], stored[1], { ...stored[2], title: 'New' }]))).toEqual(
      [],
    );
    expect(addedTasksErrors(stored, CONTRACT, answer([stored[0], stored[1]]))).toEqual([]);
  });

  it('counts an old text decision as kept when the answer carries its text in an item with an owner', () => {
    const items = { ...answer(stored), contract: [{ id: 'tz', owner: 'a', text: CONTRACT }] };
    expect(addedTasksErrors(stored, CONTRACT, items)).toEqual([]);
  });

  it('refuses a contract decision that is gone, and accepts the same decisions in other entries', () => {
    const errors = addedTasksErrors(stored, CONTRACT, answer(stored, ['decisions:\n- the field is called `split`']));
    expect(errors).toEqual([
      'the contract decision "subtask a: store UTC in every table" is already followed and cannot be removed',
    ]);
    expect(
      addedTasksErrors(
        stored,
        CONTRACT,
        answer(stored, ['the field is called `split`', 'subtask a: store UTC\nin every table']),
      ),
    ).toEqual([]);
  });

  it('checks nothing for a first plan, with no stored task or only planned ones', () => {
    expect(addedTasksErrors([], '', answer([task('x', 'pending')]))).toEqual([]);
    expect(addedTasksErrors([task('c', 'pending')], CONTRACT, answer([]))).toEqual([]);
  });
});

describe('keepStored', () => {
  it('keeps the started task with its status and merge commits, and leaves new and planned tasks as built', () => {
    const stored = [task('a', 'merged', { merged: { demo: 'abc' }, note: 'delivered' }), task('c', 'pending')];
    const graph = buildGraph(
      answer([task('a', 'pending'), task('c', 'pending', { title: 'New' }), task('d', 'pending')]),
    );

    const kept = keepStored(stored, graph);

    expect(kept.tasks[0]).toEqual(stored[0]);
    expect(kept.tasks.slice(1).map((item) => [item.id, item.title, item.status])).toEqual([
      ['c', 'New', 'pending'],
      ['d', 'Task d', 'pending'],
    ]);
    expect(kept.contract).toBe(graph.contract);
  });
});
