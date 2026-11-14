import { readFileSync } from 'fs';
import { join } from 'path';
import { ARTIFACTS } from '../contract/artifacts';
import { plan } from '../../agent-result/definitions/plan';
import type { SplitFields, SplitTask } from '../../agent-result/definitions/split-fields';
import { readResult } from '../../agent-result/read-result';
import {
  buildGraph,
  isSplit,
  planItemsFromTasks,
  reaches,
  renderContract,
  splitOutputs,
  taskErrors,
  unbounded,
  withDecisions,
} from './plan-tasks';

const limits = { maySplit: true, maxTasks: 12 };

const column: SplitTask = {
  id: 'column',
  title: 'Add the column',
  depends: [],
  files: ['a.ts', 'b.ts'],
  proof: 'a.spec.ts "reads it"',
  description: 'Adds it.',
};
const api: SplitTask = {
  id: 'api',
  title: 'Send it',
  depends: ['column'],
  files: ['c.ts'],
  proof: 'c.spec.ts "sends it"',
  description: 'Sends it.',
};

function answer(tasks: SplitTask[], extra: Partial<SplitFields> = {}): SplitFields {
  return { contract: ['the field is called `split`'], tasks, keep: [], ...extra };
}

describe('taskErrors', () => {
  it('has none for a valid graph, and the graph keeps every field', () => {
    expect(taskErrors(answer([column, api]), limits)).toEqual([]);
    const graph = buildGraph(answer([column, api]));
    expect(graph.contract).toBe('- the field is called `split`');
    expect(graph.tasks).toEqual([
      { ...column, status: 'pending' },
      { ...api, status: 'pending' },
    ]);
    expect(planItemsFromTasks(graph.tasks)).toEqual([
      'Add the column - files: a.ts, b.ts - proof: a.spec.ts "reads it"',
      'Send it - files: c.ts - proof: c.spec.ts "sends it"',
    ]);
  });

  it('names a cycle', () => {
    const tasks = [
      { ...column, id: 'a', depends: ['b'] },
      { ...column, id: 'b', depends: ['a'] },
    ];
    expect(taskErrors(answer(tasks), limits)).toEqual(['tasks have a dependency cycle: a -> b -> a']);
  });

  it('names an unknown dependency', () => {
    expect(taskErrors(answer([column, { ...api, depends: ['nope'] }]), limits)).toEqual([
      'task api depends on unknown task nope',
    ]);
  });

  it('names more than the safety limit, and the unbounded limit lifts it', () => {
    expect(taskErrors(answer([column, api]), { maySplit: true, maxTasks: 1 })).toEqual([
      'too many tasks: 2, the limit is 1',
    ]);
    const many = Array.from({ length: 49 }, (_, n) => ({ ...column, id: `t${n}`, files: [`f${n}.ts`] }));
    expect(taskErrors(answer(many), unbounded({ maySplit: true, maxTasks: 48 }))).toEqual([]);
    expect(taskErrors(answer(many), unbounded({ maySplit: false, maxTasks: 48 }))).toEqual([
      'tasks are not allowed: this run may not split',
    ]);
  });

  it('names a duplicate id', () => {
    expect(taskErrors(answer([column, column]), limits)).toEqual(['duplicate task id column']);
  });

  it('names a task with no proof, no description or no file', () => {
    expect(taskErrors(answer([{ ...column, proof: ' ' }]), limits)).toEqual(['task column has no proof']);
    expect(taskErrors(answer([{ ...column, description: '' }]), limits)).toEqual(['task column has no description']);
    expect(taskErrors(answer([{ ...column, files: [] }]), limits)).toEqual(['task column has no file to change']);
  });

  it('refuses tasks from a subtask and from a run that may not split', () => {
    expect(taskErrors(answer([column]), { maySplit: false, maxTasks: 12 })).toEqual([
      'tasks are not allowed: this run may not split',
    ]);
  });

  it('names a missing contract', () => {
    expect(taskErrors(answer([column], { contract: [' '] }), limits)).toEqual(['contract is missing']);
  });

  it('names every error of one answer at once', () => {
    const tasks = [
      { ...column, proof: '' },
      { ...api, depends: ['nope'], description: '' },
    ];
    expect(taskErrors(answer(tasks, { contract: [] }), { maySplit: true, maxTasks: 1 })).toEqual([
      'contract is missing',
      'too many tasks: 2, the limit is 1',
      'task column has no proof',
      'task api has no description',
      'task api depends on unknown task nope',
    ]);
  });

  it('knows a split answer by its tasks', () => {
    expect(isSplit(answer([column]))).toBe(true);
    expect(isSplit(answer([]))).toBe(false);
  });
});

describe('a task description', () => {
  const fixture = (name: string): string => readFileSync(join(__dirname, 'fixtures', name), 'utf8');
  const IDS = ['runtime-rule-files', 'prompt-rules', 'plan-skills', 'repo-rules'];
  const tasksOf = (name: string): SplitTask[] => {
    const read = readResult(plan, fixture(name));
    if (!read.ok) throw new Error(read.errors.join('; '));
    return (read.value as SplitFields).tasks;
  };

  it.each(['f49-plan.answer.md', 'f49-plan-improve.answer.md'])('keeps all four tasks of %s', (name) => {
    const tasks = buildGraph({ ...answer([]), tasks: tasksOf(name) }).tasks;
    expect(tasks.map((task) => task.id)).toEqual(IDS);
    expect(tasks[2].description).toContain('names no project, file or tool:');
    expect(tasks[3].description).toContain('one rule per line');
  });

  it('keeps a line ending with a colon, a nested list and a blank line', () => {
    expect(tasksOf('f49-plan.answer.md')[0].description).toBe(
      [
        'Each adapter says which rule files its CLI reads:',
        '- claude reads CLAUDE.md',
        '- cursor reads AGENTS.md',
        '',
        'The adapter spec pins both.',
      ].join('\n'),
    );
  });
});

describe('the contract and the plan items', () => {
  it('renders each entry as a bullet with its later lines indented', () => {
    expect(renderContract(['one rule', 'two rules:\n- nested\n\nafter a blank line'])).toBe(
      '- one rule\n- two rules:\n  - nested\n\n  after a blank line',
    );
  });

  it('is the contract text the prose reader stored for the same entries', () => {
    const entries = ['the column is called `split`', 'a second rule'];
    expect(renderContract(entries)).toBe('- the column is called `split`\n- a second rule');
  });
});

describe('shared files', () => {
  const task = (id: string, depends: string[], files: string[]): SplitTask => ({
    ...column,
    id,
    title: id,
    depends,
    files,
    proof: `${id}.spec.ts`,
  });
  const stored = (tasks: SplitTask[]): { depends: Record<string, string[]>; contract: string } => {
    const graph = buildGraph(answer(tasks));
    const doc = splitOutputs(graph).find((output) => output.artifact === ARTIFACTS.contract);
    return {
      depends: Object.fromEntries(graph.tasks.map((item) => [item.id, item.depends])),
      contract: String(doc?.value),
    };
  };

  it('chains two parallel tasks naming one file, later to earlier, with one decisions line', () => {
    const result = stored([task('a', [], ['x.ts']), task('b', [], ['x.ts', 'y.ts'])]);
    expect(result.depends).toEqual({ a: [], b: ['a'] });
    expect(result.contract).toBe('- the field is called `split`\n\ndecisions:\n- b depends on a: both change x.ts');
  });

  it('keeps tasks that share no file parallel and adds no decisions block', () => {
    const result = stored([task('a', [], ['x.ts']), task('b', [], ['y.ts'])]);
    expect(result.depends).toEqual({ a: [], b: [] });
    expect(result.contract).toBe('- the field is called `split`');
  });

  it('adds nothing for tasks already joined by a direct or transitive path', () => {
    const result = stored([task('a', [], ['x.ts']), task('b', ['a'], ['y.ts']), task('c', ['b'], ['x.ts'])]);
    expect(result.depends).toEqual({ a: [], b: ['a'], c: ['b'] });
    expect(result.contract).not.toContain('decisions:');
  });

  it('accepts an order that is not topological and puts the edge on the later task of the graph order', () => {
    const result = stored([task('c', ['b'], ['x.ts']), task('b', [], ['y.ts']), task('a', [], ['x.ts'])]);
    expect(result.depends.c).toEqual(['b']);
    expect(result.depends.b).toEqual([]);
    expect(result.depends.a).toEqual(['c']);
    expect(result.contract).toContain('- a depends on c: both change x.ts');
  });

  it('chains three tasks on one file with one edge and one line each, and no cycle', () => {
    const result = stored([task('a', [], ['x.ts']), task('b', [], ['x.ts']), task('c', [], ['x.ts'])]);
    expect(result.depends).toEqual({ a: [], b: ['a'], c: ['b'] });
    expect(result.contract.match(/depends on/g)).toHaveLength(2);
  });

  it('puts the line under an existing decisions heading', () => {
    expect(
      withDecisions('- a rule\n\ndecisions:\n- subtask q: chose it\n\n- later note', [
        'b depends on a: both change x.ts',
      ]),
    ).toBe('- a rule\n\ndecisions:\n- subtask q: chose it\n- b depends on a: both change x.ts\n\n- later note');
  });

  it('gives one edge and one line for two shared files of one pair', () => {
    const result = stored([task('a', [], ['x.ts', 'y.ts']), task('b', [], ['x.ts', 'y.ts'])]);
    expect(result.depends.b).toEqual(['a']);
    expect(result.contract.match(/depends on/g)).toHaveLength(1);
  });

  it('reaches answers a direct path, a transitive path and no path', () => {
    const tasks = buildGraph(
      answer([
        task('a', [], ['x.ts']),
        task('b', ['a'], ['y.ts']),
        task('c', ['b'], ['z.ts']),
        task('d', [], ['w.ts']),
      ]),
    ).tasks;
    expect(reaches(tasks, 'b', 'a')).toBe(true);
    expect(reaches(tasks, 'c', 'a')).toBe(true);
    expect(reaches(tasks, 'a', 'c')).toBe(false);
    expect(reaches(tasks, 'd', 'a')).toBe(false);
  });
});

describe('keep lines', () => {
  const tasks = [
    { ...column, id: 'a', files: ['a.ts'], depends: [] },
    { ...column, id: 'b', files: ['b.ts'], depends: ['a'] },
  ];
  const line = { capability: 'login works', proof: 'login.spec.ts', tasks: ['a', 'b'] };

  it('stores a valid line as the keep document, and keeps it out of the stored contract', () => {
    const graph = buildGraph(answer(tasks, { keep: [line] }));
    expect(taskErrors(answer(tasks, { keep: [line] }), limits)).toEqual([]);
    expect(graph.keep).toEqual([line]);
    expect(splitOutputs(graph).find((out) => out.artifact === ARTIFACTS.keep)?.value).toEqual([line]);
    expect(splitOutputs(graph).find((out) => out.artifact === ARTIFACTS.contract)?.value).toBe(
      '- the field is called `split`',
    );
  });

  it('clears the document with no graph', () => {
    expect(splitOutputs(null).find((out) => out.artifact === ARTIFACTS.keep)?.value).toEqual([]);
  });

  it('names a line with no task and a line with an unknown task', () => {
    expect(taskErrors(answer(tasks, { keep: [{ ...line, tasks: [] }] }), limits)).toEqual([
      'keep line names no task: login works',
    ]);
    expect(taskErrors(answer(tasks, { keep: [{ ...line, tasks: ['zed'] }] }), limits)).toEqual([
      'keep line names unknown task zed: login works',
    ]);
  });
});
