import type { Subtask } from '../../contract/subtask';
import type { StarterAnswerResult } from '../../agent-result/definitions/starter-answer';
import { readContract } from '../shared/contract-items';
import { applyStarterAnswer, decisionErrors, type StarterState } from './starter-actions';

const AT = '2026-01-01T00:00:00.000Z';

function task(id: string, status: Subtask['status'], more: Partial<Subtask> = {}): Subtask {
  return {
    id,
    title: `Task ${id}`,
    description: `Does ${id}`,
    depends: [],
    files: [`${id}.ts`],
    proof: `${id}.spec.ts`,
    covers: [],
    status,
    ...more,
  };
}

const state = (more: Partial<StarterState> = {}): StarterState => ({
  contract: '- api (owner a): the api\n',
  tasks: [task('a', 'running', { covers: ['R1'] }), task('b', 'waiting', { covers: ['R2'] })],
  requirements: [
    { id: 'R1', text: 'one' },
    { id: 'R2', text: 'two' },
  ],
  asker: 'a',
  ...more,
});

const answer = (more: Partial<StarterAnswerResult> = {}): StarterAnswerResult => ({ decision: 'Use ids.', ...more });

const added = (id: string, covers: string[] = []) => ({
  id,
  title: `Task ${id}`,
  depends: [],
  files: [`${id}.ts`],
  proof: `${id}.spec.ts`,
  description: `Does ${id}`,
  covers,
});

describe('applyStarterAnswer', () => {
  it('writes the decision to the contract with its time and changes nothing else', () => {
    const applied = applyStarterAnswer(state(), answer(), AT);

    expect(applied.errors).toEqual([]);
    expect(readContract(applied.contract).decisions).toEqual([{ task: 'a', at: AT, text: 'Use ids.' }]);
    expect(applied.tasks).toEqual(state().tasks);
    expect(applied.changes).toEqual([]);
  });

  it('returns waitFor as the needs of the asking task and does not apply it to the tasks', () => {
    const applied = applyStarterAnswer(state(), answer({ waitFor: [{ id: 'b', what: 'the helper' }] }), AT);

    expect(applied.errors).toEqual([]);
    expect(applied.waitFor).toEqual([{ id: 'b', what: 'the helper' }]);
    expect(applied.tasks.find((item) => item.id === 'a')?.depends).toEqual([]);
  });

  it('refuses a wait that could never end', () => {
    const tasks = [task('a', 'running'), task('b', 'waiting', { depends: ['a'] })];
    const applied = applyStarterAnswer(
      state({ tasks, requirements: [] }),
      answer({ waitFor: [{ id: 'b', what: 'x' }] }),
      AT,
    );

    expect(applied.errors).toEqual(['waitFor: b: b depends on a, so waiting for it would never end']);
  });

  describe('addTask', () => {
    it('appends the task, checks it as the plan is checked, and records a plan change with its reason', () => {
      const applied = applyStarterAnswer(state(), answer({ addTask: [added('c', ['R2'])] }), AT);

      expect(applied.errors).toEqual([]);
      expect(applied.tasks.map((item) => item.id)).toEqual(['a', 'b', 'c']);
      expect(applied.changes).toEqual([
        {
          taskId: 'c',
          reason: 'Subtask a asked for it: Use ids.',
          before: [],
          after: ['Task c - files: c.ts - proof: c.spec.ts'],
        },
      ]);
    });

    it('gives the reason of an added task the source a caller names', () => {
      const applied = applyStarterAnswer(state(), answer({ addTask: [added('c', ['R2'])] }), AT, 'Task a merged');

      expect(applied.changes[0].reason).toBe('Task a merged: Use ids.');
    });

    it('keeps the whole decision in the reason of an added task, so the reviewers see where a cut is marked', () => {
      const applied = applyStarterAnswer(
        state(),
        answer({ decision: 'Use ids.\nThey are short.', addTask: [added('c')] }),
        AT,
      );

      expect(applied.changes[0].reason).toBe('Subtask a asked for it: Use ids.\nThey are short.');
    });

    it('refuses an invalid task: no proof, an unknown dependency, an id in use', () => {
      const bad = { ...added('b'), proof: '', depends: ['zz'] };
      const applied = applyStarterAnswer(state(), answer({ addTask: [bad] }), AT);

      expect(applied.errors).toEqual(
        expect.arrayContaining(['duplicate task id b', 'task b has no proof', 'task b depends on unknown task zz']),
      );
      expect(applied.tasks).toEqual(state().tasks);
      expect(readContract(applied.contract).decisions).toHaveLength(1);
    });

    it('refuses a task that covers an id that is no requirement', () => {
      const applied = applyStarterAnswer(state(), answer({ addTask: [added('c', ['R9'])] }), AT);

      expect(applied.errors).toEqual(['R9 is not a requirement: Task c - files: c.ts - proof: c.spec.ts']);
    });

    it('chains a task that shares a file with an earlier one and says so under decisions', () => {
      const shared = { ...added('c', ['R2']), files: ['b.ts'] };
      const applied = applyStarterAnswer(state(), answer({ addTask: [shared] }), AT);

      expect(applied.tasks.find((item) => item.id === 'c')?.depends).toEqual(['b']);
      expect(readContract(applied.contract).decisions.map((item) => item.text)).toContain(
        'c depends on b: both change b.ts',
      );
    });
  });

  describe('changeTask and dropTask', () => {
    it('refuses a task that has started', () => {
      const change = { id: 'a', reason: 'it is wrong', title: 'New' };
      const drop = { id: 'a', reason: 'not needed' };

      for (const given of [answer({ changeTask: [change] }), answer({ dropTask: [drop] })]) {
        const applied = applyStarterAnswer(state(), given, AT);
        expect(applied.errors).toEqual(['a has started: changeTask and dropTask only for tasks that have not started']);
        expect(applied.tasks).toEqual(state().tasks);
        expect(applied.changes).toEqual([]);
      }
    });

    it('refuses a task that does not exist and a drop without a reason', () => {
      const applied = applyStarterAnswer(
        state(),
        answer({ changeTask: [{ id: 'zz', reason: 'r' }], dropTask: [{ id: 'b', reason: ' ' }] }),
        AT,
      );

      expect(applied.errors).toEqual(['changeTask: no task has the id zz', 'dropTask b: say why']);
    });

    it('changes a task that has not started and records it as a plan change with its reason', () => {
      const applied = applyStarterAnswer(
        state(),
        answer({ changeTask: [{ id: 'b', reason: 'a hands its part over', files: ['b.ts', 'part.ts'] }] }),
        AT,
      );

      expect(applied.errors).toEqual([]);
      expect(applied.tasks.find((item) => item.id === 'b')?.files).toEqual(['b.ts', 'part.ts']);
      expect(applied.changes).toEqual([
        {
          taskId: 'b',
          reason: 'a hands its part over',
          before: ['Task b - files: b.ts - proof: b.spec.ts'],
          after: ['Task b - files: b.ts, part.ts - proof: b.spec.ts'],
        },
      ]);
    });

    it('drops a task that has not started with its reason when another task covers its requirement', () => {
      const tasks = [task('a', 'running', { covers: ['R1', 'R2'] }), task('b', 'waiting', { covers: ['R2'] })];
      const applied = applyStarterAnswer(
        state({ tasks }),
        answer({ dropTask: [{ id: 'b', reason: 'a does it' }] }),
        AT,
      );

      expect(applied.errors).toEqual([]);
      expect(applied.tasks.map((item) => item.id)).toEqual(['a']);
      expect(applied.changes).toEqual([
        { taskId: 'b', reason: 'a does it', before: ['Task b - files: b.ts - proof: b.spec.ts'], after: [] },
      ]);
    });

    it('refuses a drop that leaves a requirement uncovered or a task without its dependency', () => {
      const dropped = applyStarterAnswer(state(), answer({ dropTask: [{ id: 'b', reason: 'x' }] }), AT);
      expect(dropped.errors).toEqual(['R2 is not covered: two']);

      const tasks = [task('a', 'running'), task('b', 'waiting'), task('c', 'waiting', { depends: ['b'] })];
      const orphan = applyStarterAnswer(
        state({ tasks, requirements: [] }),
        answer({ dropTask: [{ id: 'b', reason: 'x' }] }),
        AT,
      );
      expect(orphan.errors).toEqual(['task c depends on unknown task b']);
    });
  });
});

describe('decisionErrors', () => {
  it('asks for a decision, and refuses actions where the answer may not act', () => {
    expect(decisionErrors(answer({ decision: ' ' }), true)).toEqual(['decision: give the decision']);
    expect(decisionErrors(answer({ dropTask: [{ id: 'b', reason: 'x' }] }), false)).toEqual([
      'actions are not allowed here: send the decision only',
    ]);
    expect(decisionErrors(answer(), false)).toEqual([]);
  });
});
