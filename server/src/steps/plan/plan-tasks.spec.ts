import { readFileSync } from 'fs';
import { join } from 'path';
import { planItemParts } from '../../contract/plan-item';
import { ARTIFACTS } from '../contract/artifacts';
import { plan } from '../../agent-result/definitions/plan';
import type { ContractItem, SplitFields, SplitTask } from '../../agent-result/definitions/split-fields';
import { readResult } from '../../agent-result/read-result';
import {
  addTasksCheck,
  buildGraph,
  isSplit,
  planItemsFromTasks,
  reaches,
  renderContract,
  splitOutputs,
  startedTasks,
  taskErrors,
  unbounded,
  withAddedTasks,
  withDecisions,
} from './plan-tasks';

const limits = { maySplit: true, maxTasks: 12 };

const column: SplitTask = {
  id: 'column',
  title: 'Add the column',
  covers: ['R1'],
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

const item = (text: string, id = '', owner = ''): ContractItem => ({ id, text, owner });

function answer(tasks: SplitTask[], extra: Partial<SplitFields> = {}): SplitFields {
  return { contract: [item('the field is called `split`')], tasks, keep: [], ...extra };
}

describe('taskErrors', () => {
  it('has none for a valid graph, and the graph keeps every field', () => {
    expect(taskErrors(answer([column, api]), limits)).toEqual([]);
    const graph = buildGraph(answer([column, api]));
    expect(graph.contract).toBe('- the field is called `split`');
    expect(graph.tasks).toEqual([
      { ...column, status: 'pending' },
      { ...api, covers: [], status: 'pending' },
    ]);
    expect(planItemsFromTasks(graph.tasks)).toEqual([
      'Add the column - files: a.ts, b.ts - proof: a.spec.ts "reads it"',
      'Send it - files: c.ts - proof: c.spec.ts "sends it"',
    ]);
  });

  it('reads back the items it writes, with and without files', () => {
    const [item] = planItemsFromTasks([column]);
    expect(planItemParts(item)).toEqual({ text: item, files: ['a.ts', 'b.ts'], proof: 'a.spec.ts "reads it"' });
    expect(planItemParts('Just a line')).toEqual({ text: 'Just a line', files: [], proof: null });
  });

  it('names a task id that is not a part id', () => {
    const tasks = [
      { ...column, id: 'Main_Move', depends: [] },
      { ...api, id: 'a'.repeat(42), depends: [] },
    ];
    const rule =
      'a task id is a lowercase letter or digit, then lowercase letters, digits and dashes, up to 41 characters; rename it';
    expect(taskErrors(answer(tasks), limits)).toEqual([`task Main_Move: ${rule}`, `task ${'a'.repeat(42)}: ${rule}`]);
    expect(taskErrors(answer([{ ...column, id: 'a'.repeat(41), depends: [] }]), limits)).toEqual([]);
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
    expect(taskErrors(answer([column], { contract: [item(' ')] }), limits)).toEqual(['contract is missing']);
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
    expect(renderContract([item('one rule'), item('two rules:\n- nested\n\nafter a blank line')])).toBe(
      '- one rule\n- two rules:\n  - nested\n\n  after a blank line',
    );
  });

  it('writes the id and owner of an item before its text', () => {
    expect(renderContract([item('a rule\nmore', 'api', 'core'), item('old text')])).toBe(
      '- api (owner core): a rule\n  more\n- old text',
    );
  });

  it('is the contract text the prose reader stored for the same entries', () => {
    const entries = [item('the column is called `split`'), item('a second rule')];
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

describe('withAddedTasks', () => {
  const stored = () => {
    const graph = buildGraph(answer([column, api]));
    return {
      contract: graph.contract,
      tasks: graph.tasks.map((task) => ({ ...task, status: 'running' as const })),
      keep: [],
    };
  };
  const added = (tasks: SplitTask[], extra: Partial<SplitFields> = {}) =>
    answer(tasks, { contract: [item('it is sent as JSON')], ...extra });
  const test: SplitTask = {
    id: 'docs',
    title: 'Docs',
    depends: [],
    files: ['d.md'],
    proof: 'd.spec.ts',
    description: 'Docs.',
  };

  it('appends the tasks, contract entries and keep lines and leaves the stored tasks as they are', () => {
    const { graph, errors } = withAddedTasks(
      stored(),
      added([test], { keep: [{ capability: 'old', proof: 'o.spec.ts', tasks: ['docs'] }] }),
      limits,
    );

    expect(errors).toEqual([]);
    expect(graph?.tasks.map((task) => [task.id, task.status])).toEqual([
      ['column', 'running'],
      ['api', 'running'],
      ['docs', 'pending'],
    ]);
    expect(graph?.tasks.slice(0, 2)).toEqual(stored().tasks);
    expect(graph?.contract).toBe('- the field is called `split`\n\n- it is sent as JSON');
    expect(graph?.keep).toHaveLength(1);
  });

  it('chains an added task that shares a file with a stored one, and changes the stored task in no way', () => {
    const sharing = { ...test, files: ['c.ts'] };

    const { graph } = withAddedTasks(stored(), added([sharing]), limits);

    expect(graph?.tasks.find((task) => task.id === 'docs')?.depends).toEqual(['api']);
    expect(graph?.tasks.find((task) => task.id === 'api')).toEqual(stored().tasks[1]);
    expect(graph?.decisions).toEqual(['docs depends on api: both change c.ts']);
  });

  it('lets an added task depend on a stored task', () => {
    expect(withAddedTasks(stored(), added([{ ...test, depends: ['api'] }]), limits).errors).toEqual([]);
  });

  it('refuses an existing id, an unknown dependency, a cycle and a missing proof, and builds no graph', () => {
    const refused = (task: SplitTask) => withAddedTasks(stored(), added([task]), limits);
    expect(refused({ ...test, id: 'api' }).errors).toContain('duplicate task id api');
    expect(refused({ ...test, depends: ['nope'] }).errors).toContain('task docs depends on unknown task nope');
    expect(refused({ ...test, depends: ['docs'] }).errors.join()).toContain('dependency cycle');
    expect(refused({ ...test, proof: ' ' }).errors).toContain('task docs has no proof');
    expect(refused(test).graph).not.toBeNull();
    expect(refused({ ...test, id: 'api' }).graph).toBeNull();
  });

  it('gives the errors as the check of a reply and refuses a plan next to the tasks', () => {
    const check = addTasksCheck(stored(), limits);
    expect(check({ reply: 'x', tasks: [test], contract: [{ id: 'item-1', text: 'c', owner: 'a' }] })).toEqual([]);
    expect(
      check({ reply: 'x', tasks: [{ ...test, id: 'api' }], contract: [{ id: 'item-1', text: 'c', owner: 'a' }] }),
    ).toEqual(['duplicate task id api']);
    expect(check({ reply: 'x', plan: ['one'] })).toEqual([expect.stringContaining('plan is not allowed')]);
  });

  it('counts a task as started once its status is not the pending of a plan', () => {
    const tasks = stored().tasks;
    expect(startedTasks(tasks)).toHaveLength(2);
    expect(startedTasks(buildGraph(answer([column])).tasks)).toEqual([]);
  });
});
