import { readFileSync } from 'fs';
import { join } from 'path';
import { SwarmloopError } from '../../core/swarmloop-error';
import { planFromAgent } from './plan-record';
import { parseTasks, planItemsFromTasks, splitAnswer, unbounded } from './plan-tasks';

const limits = { maySplit: true, maxTasks: 12 };

function answer(tasks: string[], contract = '- the field is called `split`'): string {
  return ['contract:', contract, '', 'tasks:', ...tasks, '', 'summary:', '- why'].join('\n');
}

const column = [
  '- column | Add the column | depends: none | files: a.ts, b.ts | proof: a.spec.ts "reads it"',
  '  Adds it.',
];
const api = ['- api | Send it | depends: column | files: c.ts | proof: c.spec.ts "sends it"', '  Sends it.'];

function refused(text: string, options = limits): string {
  try {
    parseTasks(text, options);
  } catch (error) {
    expect(error).toBeInstanceOf(SwarmloopError);
    return (error as Error).message;
  }
  throw new Error('parseTasks accepted the answer');
}

describe('parseTasks', () => {
  it('a valid graph', () => {
    const graph = parseTasks(answer([...column, ...api]), limits);
    expect(graph.contract).toBe('- the field is called `split`');
    expect(graph.tasks).toEqual([
      {
        id: 'column',
        title: 'Add the column',
        description: 'Adds it.',
        depends: [],
        files: ['a.ts', 'b.ts'],
        proof: 'a.spec.ts "reads it"',
        status: 'pending',
      },
      {
        id: 'api',
        title: 'Send it',
        description: 'Sends it.',
        depends: ['column'],
        files: ['c.ts'],
        proof: 'c.spec.ts "sends it"',
        status: 'pending',
      },
    ]);
    expect(planItemsFromTasks(graph.tasks)).toEqual([
      'Add the column - files: a.ts, b.ts - proof: a.spec.ts "reads it"',
      'Send it - files: c.ts - proof: c.spec.ts "sends it"',
    ]);
  });

  it('a cycle', () => {
    const first = '- a | A | depends: b | files: a.ts | proof: x';
    const second = '- b | B | depends: a | files: b.ts | proof: y';
    expect(refused(answer([first, second]))).toBe('tasks have a dependency cycle: a -> b -> a');
  });

  it('an unknown dependency', () => {
    expect(refused(answer([...column, '- api | Send it | depends: nope | files: c.ts | proof: x']))).toBe(
      'task api depends on unknown task nope',
    );
  });

  it('more than the safety limit', () => {
    expect(refused(answer([...column, ...api]), { maySplit: true, maxTasks: 1 })).toBe(
      'too many tasks: 2, the limit is 1',
    );
  });

  it('unbounded lifts the task limit and keeps a subtask from splitting', () => {
    const many = Array.from({ length: 49 }, (_, n) => [
      `- t${n} | Task ${n} | depends: none | files: a.ts | proof: a.spec.ts "t${n}"`,
      '  Does it.',
    ]).flat();
    expect(parseTasks(answer(many), unbounded({ maySplit: true, maxTasks: 48 })).tasks).toHaveLength(49);
    expect(refused(answer(many), unbounded({ maySplit: false, maxTasks: 48 }))).toContain('tasks are not allowed');
  });

  it('a duplicate id', () => {
    expect(refused(answer([...column, ...column]))).toBe('duplicate task id column');
  });

  it('an empty proof', () => {
    expect(refused(answer(['- a | A | depends: none | files: a.ts | proof: ']))).toBe('task a has no proof');
  });

  it('tasks from a subtask refused', () => {
    expect(refused(answer(column), { maySplit: false, maxTasks: 12 })).toBe(
      'tasks are not allowed: this run may not split',
    );
  });

  it('tasks from a run that may not split refused', () => {
    expect(refused(answer([...column, ...api]), { maySplit: false, maxTasks: 12 })).toContain('may not split');
  });

  it('names a missing contract and a malformed line', () => {
    expect(refused(['tasks:', ...column].join('\n'))).toBe('contract is missing');
    expect(refused(answer(['- a | only a title']))).toContain('task line is malformed');
  });

  it('old plan answers parse as before', () => {
    const old = ['plan:', '- add the field - files: a.ts - proof: a.spec.ts', '', 'summary:', '- why'].join('\n');
    expect(splitAnswer(old)).toBe(false);
    expect(planFromAgent(old).items).toEqual(['add the field - files: a.ts - proof: a.spec.ts']);
    expect(splitAnswer(answer(column))).toBe(true);
  });
});

describe('a task description', () => {
  const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
  const IDS = ['runtime-rule-files', 'prompt-rules', 'plan-skills', 'repo-rules'];

  it.each(['f49-plan.answer.md', 'f49-plan-improve.answer.md'])('keeps all four tasks of %s', (name) => {
    const tasks = parseTasks(fixture(name), limits).tasks;
    expect(tasks.map((task) => task.id)).toEqual(IDS);
    expect(tasks[2].description).toContain('names no project, file or tool:');
    expect(tasks[3].description).toContain('one rule per line');
  });

  it('keeps a line ending with a colon, a nested list and a blank line', () => {
    const tasks = parseTasks(fixture('f49-plan.answer.md'), limits).tasks;
    expect(tasks[0].description).toBe(
      [
        'Each adapter says which rule files its CLI reads:',
        '- claude reads CLAUDE.md',
        '- cursor reads AGENTS.md',
        '',
        'The adapter spec pins both.',
      ].join('\n'),
    );
  });

  it('ends at a summary label after the tasks', () => {
    const tasks = parseTasks(answer([...column, ...api]), limits).tasks;
    expect(tasks[1].description).toBe('Sends it.');
  });

  it('fails naming a task line outside the tasks section', () => {
    const text = `${answer(column)}\n- lost | Lost | depends: none | files: z.ts | proof: z.spec.ts\n`;
    expect(refused(text)).toBe('tasks lost were written but not read');
  });

  it('fails naming an indented task line', () => {
    const text = answer([...column, '  - nested | Nested | depends: none | files: z.ts | proof: z.spec.ts']);
    expect(refused(text)).toBe('tasks nested were written but not read');
  });

  it('fails for a task with no description', () => {
    const text = answer([...column, '- bare | Bare | depends: none | files: z.ts | proof: z.spec.ts']);
    expect(refused(text)).toBe('task bare has no description');
  });
});
