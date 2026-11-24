import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../agent/agent-runner';
import { PLAN_CHAT_KIND, type PlanChatEntry } from '../contract/plan-chat';
import { STEPS, type StepName } from '../contract/steps';
import { settled, withStatuses } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { PipelineService } from '../pipeline/pipeline.service';
import { REASON } from '../contract/run-state';
import { ARTIFACTS, reviewResultOf } from '../steps/contract/artifacts';
import { InputReader } from '../steps/contract/input-reader';
import { JUMPS, RETURNS } from '../steps/contract/returns';
import { boot, reply, reportReply, result, seed, writeEnv } from '../steps/code-review/code-review.step.spec-helpers';
import { gapOf } from '../steps/implement/review-gaps';
import { implementRunner } from '../steps/implement/split-or-fix';
import { seedParent, task, world } from '../steps/implement/split-implement.spec-helpers';
import { openQuestions } from '../steps/shared/answers';
import { sameInput } from '../steps/shared/same-input';
import { readVisitInput } from '../steps/shared/visit-input';
import { copyMainWithOrigin } from './git-fixture';
import type { ObservedChain } from './flow-routes-chain.spec-helpers';
import { gitWorktree } from './git-worktree.spec-helpers';
import type { ReviewResult } from '../agent-result/definitions/review';

/** The visit of code-review that launches reviewers: the node no return may reach again without a change in between. */
export const ROUND = 'code-review round';
/** The hop to code-review, where the door of every agent start decides whether the round starts. */
export const DOOR = 'code-review';
export const PERSON = 'person';
/** A node a planner holds a question in, for each level of the chain. */
export const PLANNERS = ['planner: run', 'planner: epic', 'planner: backlog'] as const;
/** The implement agent works on the tree; so does a subtask's task. */
export const AGENT = 'implement agent';
export const TASK = 'task';
/** A subtask's own code-review round, which settles by its reviewers' decisions as given. */
export const SUBTASK_ROUND = 'subtask code-review round';
export const SETTLE = 'code-review settles on the planner answers';

export interface RouteEdge {
  from: string;
  to: string;
  why: string;
}

export interface RouteGraph {
  edges: RouteEdge[];
  /** Nodes that can change the tree: a path ends there. */
  changes: ReadonlySet<string>;
  /** Nodes where a person decides: a path ends there. */
  stops: ReadonlySet<string>;
}

/** Where a planner's answer to a reviewer's question lands, as the real code-review step did it. */
export type AnswerOutcome = 'holds' | 'ruled-out' | 'instruction' | 'unanswered' | 'escalated';

/** What the real decisions gave for each state class, as the graph reads them. */
export interface Observed {
  /** The implement of a split parent, by state class: who runs it and where the server pass goes on. Empty for a single run. */
  states: Record<string, { runner: 'agent' | 'split'; then: 'task' | 'person' | 'next' }>;
  /** What one code-review visit did after each answer: the step it ended at, and the reviewers it launched. */
  answers: Record<AnswerOutcome, { step: string; waiting: boolean; asksPlanner: boolean; reviewers: number }>;
  /** What the door decides for a start of code-review on a head, brief and instructions that did not change. */
  door: 'same' | 'new';
  /** The planners' chain and the subtask's review, as the real chain, hop gate and review rules gave them. */
  chain: ObservedChain;
}

const order = (from: StepName): StepName | undefined => STEPS[STEPS.indexOf(from) + 1];

/** The nodes `implement` resolves to for a return: the agent, or the server pass of each state class. */
function implementNodes(observed: Observed): { node: string; edges: RouteEdge[] }[] {
  const entries = Object.entries(observed.states);
  if (entries.length === 0) return [{ node: AGENT, edges: [] }];
  return entries.map(([state, { runner, then }]) => {
    if (runner === 'agent') return { node: AGENT, edges: [] };
    const node = `split pass: ${state}`;
    const target = then === 'task' ? TASK : then === 'person' ? PERSON : 'implement-improve';
    return { node, edges: [{ from: node, to: target, why: `the pass ends with ${then}` }] };
  });
}

const starterNode = (chain: ObservedChain) => (chain.backlogStarter ? PLANNERS[2] : PERSON);

/** The route graph of one run: the steps in order, the returns and jumps of the tables, and the decisions observed. */
export function routeGraph(observed: Observed, kind: 'single' | 'split'): RouteGraph {
  const edges: RouteEdge[] = [];
  const add = (from: string, to: string, why: string) => edges.push({ from, to, why });
  for (const step of STEPS) {
    const next = order(step);
    if (!next) continue;
    // A hop to code-review meets the door; the round's own successor is the commit.
    add(step === DOOR ? ROUND : step, next === DOOR ? DOOR : next, 'next step');
  }
  const resolved = implementNodes(observed);
  for (const [from, targets] of Object.entries(RETURNS)) {
    for (const node of targets?.includes('implement') ? resolved.map((item) => item.node) : []) {
      add(from === DOOR ? ROUND : from, node, `${from} returns to implement`);
    }
  }
  for (const [from, targets] of Object.entries(JUMPS)) {
    for (const to of targets ?? []) {
      add(from === DOOR ? ROUND : from, to === 'implement' ? AGENT : to, `${from} jumps to ${to}`);
    }
  }
  edges.push(...resolved.flatMap((item) => item.edges));
  add('implement', AGENT, 'the agent runs');
  add(AGENT, 'implement-improve', 'the agent is done');
  // The door: a start on an input that did not change is refused and asks up the chain; a new input starts the round.
  if (observed.door === 'same') add(DOOR, PLANNERS[0], 'the same input is refused and asks the chain');
  else add(DOOR, ROUND, 'a start on any input goes on');
  const { chain } = observed;
  const levelNode = (level: string) =>
    level === 'run-planner' ? PLANNERS[0] : level === 'epic-planner' ? PLANNERS[1] : starterNode(chain);
  for (const levels of kind === 'split' ? [chain.alone, chain.task] : [chain.alone]) {
    levels.slice(0, -1).forEach((level, index) => {
      add(levelNode(level), levelNode(levels[index + 1]), 'the question goes up the chain');
    });
  }
  if (chain.backlogStarter) add(PLANNERS[2], PERSON, 'the backlog planner passes the question on');
  const climbing = new Set((kind === 'split' ? [...chain.alone, ...chain.task] : chain.alone).map(levelNode));
  for (const node of climbing) {
    if (chain.refusal.again) add(node, DOOR, 'the planner answers a refused start, which starts again');
  }
  if (!chain.refusal.ends) add(starterNode(chain), DOOR, 'a refusal at the starter starts again');
  // A reviewer's question waits for the planners; the answer settles the round.
  add(ROUND, PLANNERS[0], 'a reviewer returns with a question');
  PLANNERS.forEach((level) => add(level, SETTLE, 'the planner answers the reviewer'));
  // A subtask's reviewers count as given: its round returns to its own implement, and asks only when the rules let it.
  add(SUBTASK_ROUND, AGENT, 'a subtask review returns to its implement');
  if (chain.subtaskAsks) add(SUBTASK_ROUND, PLANNERS[0], 'a subtask reviewer returns with a question');
  for (const [outcome, seen] of Object.entries(observed.answers)) {
    if (seen.reviewers > 0) add(SETTLE, ROUND, `${outcome}: a reviewer runs again`);
    else if (seen.step === 'implement') add(SETTLE, AGENT, `${outcome}: the return goes to implement`);
    else if (seen.asksPlanner) add(SETTLE, PLANNERS[0], `${outcome}: the question waits`);
    else if (seen.waiting) add(SETTLE, PERSON, `${outcome}: the question waits for the person`);
    else add(SETTLE, seen.step, `${outcome}: the round goes on without a reviewer`);
  }
  return { edges, changes: new Set([AGENT, TASK]), stops: new Set([PERSON]) };
}

/** The paths from a return of code-review or pipeline (or a question of a reviewer) to a round, passing no node that changes the tree and no person. */
export function circles(graph: RouteGraph): string[][] {
  const out = (node: string) => graph.edges.filter((edge) => edge.from === node);
  const found: string[][] = [];
  const walk = (node: string, path: string[]): void => {
    for (const edge of out(node)) {
      if (edge.to === ROUND) found.push([...path, ROUND]);
      else if (!graph.changes.has(edge.to) && !graph.stops.has(edge.to) && !path.includes(edge.to)) {
        walk(edge.to, [...path, edge.to]);
      }
    }
  };
  const starts = graph.edges.filter(
    (edge) =>
      ((edge.from === ROUND || edge.from === SUBTASK_ROUND) && edge.to !== 'commit') ||
      (edge.from === 'pipeline' && edge.why.includes('returns')),
  );
  for (const edge of starts) {
    if (!graph.changes.has(edge.to) && !graph.stops.has(edge.to)) walk(edge.to, [edge.from, edge.to]);
  }
  return found;
}

/** The door's decision for a start of code-review after steps that changed nothing: answers, handoffs, returns, a planner's turn. */
export async function observeDoor(): Promise<'same' | 'new'> {
  const root = mkdtempSync(join(tmpdir(), 'flow-routes-door-'));
  try {
    const stored = new Map<string, string>();
    const documents = {
      latestBody: async (_key: string, kind: string) => stored.get(kind) ?? null,
      latestDocument: async (_key: string, kind: string) =>
        stored.has(kind) ? { id: 1, body: stored.get(kind) } : null,
    } as unknown as DocumentRepository;
    const { clone } = copyMainWithOrigin(root, 'main');
    const run = { key: 'run-1', targetPath: clone, prompt: 'Build it.' };
    const deps = { documents, worktrees: root };
    const before = await readVisitInput(deps, run, 'code-review');
    const answer: PlanChatEntry = {
      key: 'answer-1',
      role: 'planner',
      kind: 'answer',
      text: 'It stands.',
      at: 't',
      state: 'taken',
    };
    stored.set(PLAN_CHAT_KIND, JSON.stringify({ entries: [answer], revisions: [] }));
    stored.set(ARTIFACTS.answers.kind, 'Use the old way.');
    stored.set(ARTIFACTS.return.kind, '## code-review\nFix the name.');
    stored.set(ARTIFACTS.handoff.kind, JSON.stringify([{ step: 'implement', body: 'Changed nothing.' }]));
    const after = await readVisitInput(deps, run, 'code-review');
    const facts = {
      step: 'code-review',
      digest: after,
      stats: [{ id: 1, step: 'code-review', attempt: 1, attemptId: 'a1', status: 'done', killReason: null }],
      starts: [{ step: 'code-review', attemptId: 'a1', inputDigest: before }],
      reasonCode: null,
    };
    return sameInput(facts).kind === 'same' ? 'same' : 'new';
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const LATER = '2999-01-01T00:00:00.000Z';
const EARLIER = '2000-01-01T00:00:00.000Z';
const missing: ReviewResult = {
  decision: 'return',
  review: 'Checked.',
  summary: [],
  requirements: [{ id: 'R2', status: 'missing', note: 'not written' }],
};

/** Who runs a split parent's implement in each state class, by the real decisions, and where its server pass goes on. */
export async function observeStates(): Promise<Observed['states']> {
  const { app } = await world();
  try {
    const documents = app.app.get(DocumentRepository);
    const states: Observed['states'] = {};
    const merged = (id: string) => ({ ...task(id), status: 'merged' as const, covers: ['R2'] });
    const observe = async (
      name: string,
      parent: Awaited<ReturnType<typeof seedParent>>,
      settledAt: string,
      questions = false,
    ) => {
      await documents.putDocument(parent, 'contract', '- api (owner a): the api\n');
      const subtasks = { settledAt: () => Promise.resolve(settledAt) };
      const tasks = JSON.parse((await documents.latestBody(parent.key, 'subtasks')) ?? '[]') as { id: string }[];
      const taken = JSON.parse((await documents.latestBody(parent.key, 'starter_taken')) ?? '[]') as string[];
      const runner = await implementRunner(new InputReader(documents), documents, subtasks, parent);
      const unsettled = !withStatuses(tasks as never).every(settled);
      const gap = await gapOf(documents, subtasks, parent, tasks, taken);
      const asking =
        questions || openQuestions((await documents.latestBody(parent.key, 'subtask_questions')) ?? '', []).length > 0;
      states[name] = { runner, then: unsettled || gap ? 'task' : asking ? 'person' : 'next' };
    };
    const requirements = () => reviewResultOf('requirements').format(missing);
    const parent = await seedParent(app, [
      { ...task('a'), status: 'merged' },
      { ...task('b'), status: 'running' },
    ]);
    await observe('tasks running', parent, LATER);
    await documents.putDocument(parent, 'subtasks', `${JSON.stringify([merged('a'), merged('b')])}\n`);
    await documents.putDocument(parent, 'return', 'quality returned the change\n');
    await observe('return after the last merge', parent, EARLIER);
    await documents.putDocument(parent, reviewResultOf('requirements').kind, requirements());
    await documents.putDocument(parent, 'return', 'requirements returned the change\n');
    await observe('requirements return after the last merge', parent, EARLIER);
    await observe('gap review before the last merge', parent, LATER);
    const gap = `gap-${(await documents.latestDocument(parent.key, reviewResultOf('requirements').kind))!.id}`;
    const newest = (await documents.latestDocument(parent.key, 'return'))!.id;
    await documents.putDocument(parent, 'starter_taken', JSON.stringify([`${gap}@return-${newest}`]));
    await observe('gap taken', parent, LATER);
    await documents.putDocument(parent, 'starter_taken', '[]');
    await documents.putDocument(parent, 'subtask_questions', '- Which policy wins?\n');
    await observe('subtask questions open', parent, EARLIER, true);
    return states;
  } finally {
    await app.close();
  }
}

/** What the real code-review step does after the planner's answer of each kind, to a round whose reviewer returned with a question. */
export async function observeAnswers(): Promise<Observed['answers']> {
  const root = await mkdtemp(join(tmpdir(), 'flow-routes-answers-'));
  await writeEnv(root);
  let current: jest.Mock = jest.fn();
  const app = await boot(
    root,
    jest.fn((...args: unknown[]) => current(...args)),
  );
  try {
    const runs = () => app.get(RunRepository);
    const chat = () => app.get(PlanChatStore);
    let counter = 0;
    const visit = async (key: string) => {
      const run = (await runs().findRun(key))!;
      run.currentStep = 'code-review';
      run.status = 'waiting';
      await runs().saveRun(run);
      return app.get(PipelineService).step('code-review', key);
    };
    const observe = async (fields: Record<string, unknown> | null) => {
      const key = `ROUTE-${(counter += 1)}`;
      gitWorktree(join(root, 'worktrees', key, 'billing-api'));
      const launched: string[] = [];
      current = jest.fn(async (input: AgentRunInput) => {
        launched.push(input.step);
        const name = input.step.replace('code-review-', '');
        return result(
          input.step.endsWith('report')
            ? reportReply()
            : reply(
                input.step,
                name === 'requirements' ? 'return' : 'ok',
                input.prompt.includes('Give that one line in `reason`') ? 'It still holds.' : undefined,
              ),
        );
      });
      await seed(app, key);
      const documents = app.get(DocumentRepository);
      const run = (await runs().findRun(key))!;
      await documents.putDocument(
        run,
        'requirements',
        `${JSON.stringify({ prompt: 'Ship the field\n', tickets: [], plan: { name: 'Drop', overview: '', items: ['Remove it'], decision: 'approve' } })}\n`,
      );
      await app.get(PipelineService).step('code-review', key);
      await visit(key);
      const [question] = (await chat().read(key)).entries.filter((entry) => entry.kind === 'question');
      launched.length = 0;
      if (fields) {
        await chat().appendEntry(key, {
          key: `${fields.kind === 'escalation' ? 'escalate' : 'answer'}-${question.key}`,
          role: 'planner',
          from: 'code-review-requirements',
          text: 'The planner decided.',
          at: '2026-01-01T00:00:00.000Z',
          state: 'pending',
          ...fields,
        });
        await chat().markTaken(key, [question.key]);
      }
      await visit(key);
      const after = (await runs().findRun(key))!;
      return {
        step: after.currentStep,
        waiting: after.status === 'waiting' && after.currentStep === 'code-review',
        asksPlanner: (after.stateReason ?? '').includes(REASON.asksPlanner),
        reviewers: launched.filter((step) => step.startsWith('code-review-') && !step.endsWith('report')).length,
      };
    };
    return {
      holds: await observe({ kind: 'answer', finding: 'holds' }),
      'ruled-out': await observe({ kind: 'answer', finding: 'ruled-out' }),
      instruction: await observe({ kind: 'answer', finding: 'ruled-out', instruction: 'Drop the catch-up too.' }),
      unanswered: await observe(null),
      escalated: await observe({ kind: 'escalation' }),
    };
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
}
