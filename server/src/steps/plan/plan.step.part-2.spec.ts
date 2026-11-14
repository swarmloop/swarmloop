import 'reflect-metadata';
import { resultAnswer } from '../../testing/result-answer';
import { planBlock, runSplit } from './plan.step.spec-helpers';

const splitTasks = [
  {
    id: 'column',
    title: 'Add the column',
    depends: [],
    files: ['a.ts'],
    proof: 'a.spec.ts',
    description: 'Adds it.',
  },
  {
    id: 'api',
    title: 'Send it',
    depends: ['column'],
    files: ['b.ts'],
    proof: 'b.spec.ts',
    description: 'Sends it.',
  },
];

const splitReply = resultAnswer('Done.', {
  summary: ['two parts'],
  contract: ['the column is called `split`'],
  tasks: splitTasks,
});

describe('plan step with split', () => {
  it('split answer writes plan items, subtasks and contract', async () => {
    const out = await runSplit('PROJ-80', splitReply);
    expect(out.done.exitCode).toBe(0);
    expect(out.run?.currentStep).toBe('plan-improve');
    expect(JSON.parse(out.requirements ?? '{}').plan.items).toEqual([
      'Add the column - files: a.ts - proof: a.spec.ts',
      'Send it - files: b.ts - proof: b.spec.ts',
    ]);
    expect(JSON.parse(out.subtasks ?? '[]')).toMatchObject([
      { id: 'column', depends: [], status: 'pending' },
      { id: 'api', depends: ['column'], status: 'pending' },
    ]);
    expect(out.contract).toContain('the column is called `split`');
  });

  it('stores a plan of 49 tasks at the default task limit, for plan-improve to merge', async () => {
    const tasks = Array.from({ length: 49 }, (_, n) => ({
      id: `t${n}`,
      title: `Task ${n}`,
      depends: [],
      files: [`f${n}.ts`],
      proof: 'a.spec.ts',
      description: 'Does it.',
    }));
    const answer = resultAnswer('Done.', { summary: ['why'], contract: ['one field'], tasks });
    const out = await runSplit('PROJ-83', answer);
    expect(out.done.exitCode).toBe(0);
    expect(out.run?.currentStep).toBe('plan-improve');
    expect(JSON.parse(out.subtasks ?? '[]')).toHaveLength(49);
  });

  it('a bad graph is a plan error', async () => {
    const out = await runSplit(
      'PROJ-81',
      resultAnswer('Done.', {
        summary: ['two parts'],
        contract: ['x'],
        tasks: [{ ...splitTasks[0], depends: ['api'] }, splitTasks[1]],
      }),
    );
    expect(out.done.exitCode).toBe(1);
    expect(out.done.message).toContain('tasks have a dependency cycle: column -> api -> column');
    expect(out.subtasks).toBeFalsy();
  });

  it('tasks refused for a subtask', async () => {
    const out = await runSplit('PROJ-82-t1', splitReply, { subtask: true });
    expect(out.done.exitCode).toBe(1);
    expect(out.done.message).toContain('tasks are not allowed');
    expect(out.subtasks).toBeFalsy();
  });

  it('tasks refused when split is off', async () => {
    const out = await runSplit('PROJ-83', splitReply, { split: false });
    expect(out.done.exitCode).toBe(1);
    expect(out.done.message).toContain('tasks are not allowed');
  });

  it('a plain plan clears subtasks', async () => {
    const out = await runSplit('PROJ-84', planBlock(['add the field']));
    expect(out.done.exitCode).toBe(0);
    expect(JSON.parse(out.subtasks ?? 'null')).toEqual([]);
    expect(out.contract).toBeFalsy();
  });

  it('a plain plan writes no subtasks for a run that does not split', async () => {
    const out = await runSplit('PROJ-85', planBlock(['add the field']), { split: false });
    expect(out.done.exitCode).toBe(0);
    expect(out.subtasks).toBeFalsy();
  });
});
