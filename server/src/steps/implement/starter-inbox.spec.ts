import type { RunEntity } from '../../history/entities';
import type { Subtask } from '../../contract/subtask';
import type { StarterAnswerResult } from '../../agent-result/definitions/starter-answer';
import { readContract } from '../shared/contract-items';
import type { StepContext } from '../base-step';
import { ARTIFACTS } from '../contract/artifacts';
import type { Escalated } from '../shared/subtask-ops';
import { StarterInbox } from './starter-inbox';
import type { PlanChange } from './starter-actions';

const AT = '2026-01-01T00:00:00.000Z';
const parent = { key: 'epic' } as RunEntity;
const ctx = { opened: { run: parent, startedAt: AT }, options: {} } as unknown as StepContext;

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

/** The parent's documents and the subtask runs, as far as the inbox reads them. */
function world(options: {
  reports?: Record<string, unknown>;
  asking?: string[];
  needs?: string[];
  answers?: (task: Subtask) => StarterAnswerResult | Escalated | null;
  taken?: string[];
}) {
  const documents: Record<string, string> = {
    [`epic/${ARTIFACTS.starterTaken.kind}`]: JSON.stringify(options.taken ?? []),
    [`epic/${ARTIFACTS.requirementList.kind}`]: ARTIFACTS.requirementList.format([{ id: 'R1', text: 'one' }]),
    ...Object.fromEntries(
      Object.entries(options.reports ?? {}).map(([id, report]) => [
        `epic-${id}/${ARTIFACTS.starterReport.kind}`,
        JSON.stringify(report),
      ]),
    ),
  };
  const asked: string[] = [];
  const revisions: PlanChange[][] = [];
  const subtasks = {
    find: async (_run: RunEntity, id: string) => ({ key: `epic-${id}`, currentStep: 'implement' }),
    asking: async (child: RunEntity) => (options.asking ?? []).includes(child.key),
    needsOf: async (child: RunEntity) => ((options.needs ?? []).includes(child.key) ? [{ id: 'x', what: 'y' }] : []),
    replyPending: () => false,
    answer: async (_opened: unknown, child: RunEntity, given: Subtask) => {
      asked.push(child.key);
      return options.answers?.(given) ?? null;
    },
    recordRevisions: async (_run: RunEntity, changes: PlanChange[]) => void revisions.push(changes),
  };
  const reader = {
    reread: async (key: string, artifact: { kind: string; parse: (body: string) => unknown }) => {
      const body = documents[`${key}/${artifact.kind}`];
      return body === undefined ? null : artifact.parse(body);
    },
  };
  return { inbox: new StarterInbox({ subtasks, reader } as never), asked, revisions };
}

const tasks = (): Subtask[] => [task('a', 'running', { covers: ['R1'] }), task('b', 'waiting'), task('c', 'running')];

describe('StarterInbox reports', () => {
  const report = [
    { key: 'plan-1', decisions: [{ item: 'api', text: 'Ids are numbers.' }], outOfScope: [] },
    { key: 'implement-2', decisions: [], outOfScope: [{ what: 'the docs', needed: false }] },
  ];

  it('writes the decisions of an open task to the contract with its time, without asking anyone', async () => {
    const { inbox, asked } = world({ reports: { a: report } });

    const pass = await inbox.take(ctx, tasks(), '- api (owner a): the api\n', []);

    expect(readContract(pass.contract).decisions).toEqual([{ task: 'a', at: AT, text: 'api: Ids are numbers.' }]);
    expect(pass.taken).toEqual(['epic-a/plan-1', 'epic-a/implement-2']);
    expect(asked).toEqual([]);
  });

  it('takes a report once', async () => {
    const { inbox } = world({ reports: { a: report }, taken: ['epic-a/plan-1', 'epic-a/implement-2'] });

    const pass = await inbox.take(ctx, tasks(), '- api (owner a): the api\n', []);

    expect(pass.contract).toBe('- api (owner a): the api\n');
    expect(pass.taken).toBeNull();
  });

  it('does not read the report of a task that is settled', async () => {
    const merged = [task('a', 'merged'), task('b', 'waiting')];
    const { inbox } = world({ reports: { a: report } });

    expect((await inbox.take(ctx, merged, '', [])).taken).toBeNull();
  });
});

describe('StarterInbox asks', () => {
  it('asks the planner for one waiting task per pass and records the changes of its answer', async () => {
    const { inbox, asked, revisions } = world({
      asking: ['epic-a', 'epic-c'],
      answers: () => ({
        decision: 'b takes the docs.',
        waitFor: [{ id: 'b', what: 'the docs' }],
        changeTask: [{ id: 'b', reason: 'a hands the docs over', files: ['b.ts', 'docs.md'] }],
      }),
    });

    const pass = await inbox.take(ctx, tasks(), '- api (owner a): the api\n', []);

    expect(asked).toEqual(['epic-a']);
    expect(pass.asks).toEqual([]);
    expect(pass.tasks.find((item) => item.id === 'b')?.files).toEqual(['b.ts', 'docs.md']);
    expect(readContract(pass.contract).decisions).toEqual([{ task: 'a', at: AT, text: 'b takes the docs.' }]);
    expect(revisions).toEqual([[expect.objectContaining({ taskId: 'b', reason: 'a hands the docs over' })]]);
  });

  it('turns a part nobody owns into a new task, which is appended and not dropped', async () => {
    const { inbox } = world({
      asking: ['epic-a'],
      answers: () => ({
        decision: 'A new task does the docs.',
        waitFor: [{ id: 'docs', what: 'the docs' }],
        addTask: [
          {
            id: 'docs',
            title: 'Docs',
            depends: [],
            files: ['docs.md'],
            proof: 'docs.spec.ts',
            description: 'd',
            covers: [],
          },
        ],
      }),
    });

    const pass = await inbox.take(ctx, tasks(), '- api (owner a): the api\n', []);

    expect(pass.tasks.map((item) => item.id)).toEqual(['a', 'b', 'c', 'docs']);
  });

  it('leaves a task alone that waits for a sibling or has a question open for the person', async () => {
    const { inbox, asked } = world({
      asking: ['epic-a', 'epic-c'],
      needs: ['epic-a'],
      answers: () => ({ decision: 'x' }),
    });

    await inbox.take(ctx, tasks(), '', ['c']);

    expect(asked).toEqual([]);
  });

  it('puts the question to the person who started the run when the planner gave no usable answer', async () => {
    const { inbox } = world({ asking: ['epic-a'], answers: () => null });

    const pass = await inbox.take(ctx, tasks(), '- api (owner a): the api\n', []);

    expect(pass.asks).toHaveLength(1);
    expect(pass.asks[0].question).toContain('Subtask a asks:');
    expect(pass.tasks).toEqual(tasks());
  });

  it('holds an escalation with the words of the planner, applies no decision and asks the task no more while it is open', async () => {
    const { inbox, asked, revisions } = world({
      asking: ['epic-a'],
      answers: () => ({ escalate: 'Should the api use numbers or text for ids?' }),
    });

    const pass = await inbox.take(ctx, tasks(), '- api (owner a): the api\n', []);

    expect(pass.asks).toHaveLength(1);
    expect(pass.asks[0].question).toContain('Subtask a asks:');
    expect(pass.asks[0].question).toContain('Should the api use numbers or text for ids?');
    expect(pass.contract).toBe('- api (owner a): the api\n');
    expect(pass.tasks).toEqual(tasks());
    expect(revisions).toEqual([]);

    await inbox.take(ctx, tasks(), '', ['a']);
    expect(asked).toEqual(['epic-a']);
  });

  it('keeps a started task as it is when the answer would change it', async () => {
    const { inbox, revisions } = world({
      asking: ['epic-a'],
      answers: () => ({ decision: 'Rewrite c.', changeTask: [{ id: 'c', reason: 'wrong', title: 'New' }] }),
    });

    const pass = await inbox.take(ctx, tasks(), '- api (owner a): the api\n', []);

    expect(pass.tasks).toEqual(tasks());
    expect(revisions).toEqual([[]]);
  });
});
