import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import type { DocumentRepository } from '../../history/document.repository';
import type { FlowRepository } from '../../history/flow.repository';
import type { AppConfig } from '../../config/env';
import type { Clock } from '../../core/clock';
import { SwarmloopError } from '../../core/swarmloop-error';
import { settled, withStatuses } from '../../contract/subtask';
import type { PlanChatStore } from '../../history/plan-chat.store';
import type { PlanChatEntry } from '../../contract/plan-chat';
import type { SandboxMount } from '../../core/sandbox-mount';
import { worktreeStatus } from '../../git/worktree-git';
import type { RebaseStop } from '../../git/rebase';
import type { EnvironmentService } from '../../environment/environment.service';
import { textDocument } from '../shared/handoff';
import type { BaseTips } from '../shared/base-tips';
import type { RebasedPublisher } from '../shared/rebased-publisher';
import type { RunAuthor } from '../shared/run-author';
import type { RunNames } from '../shared/run-names';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import type { ModelStepContext } from '../agent-step';
import { firstPass, renderImplementation } from './implement-record';
import { waitForPlanner } from './implement-question';
import { settledRecord } from './split-handover';

/** What finishing an open rebase needs from the implement step. */
export interface RebaseDeps {
  config: AppConfig;
  documents: DocumentRepository;
  flows: FlowRepository;
  publisher: RebasedPublisher;
  /** What each repository of a run stood on: the base its own change is measured from. */
  tips: BaseTips;
  names: RunNames;
  author: RunAuthor;
  environments: EnvironmentService;
  step: string;
  runtime: RuntimeName;
  /** Where a conflict the agent could not resolve is asked. Without it the step fails with the files and git's message. */
  chat?: PlanChatStore;
  clock: Clock;
}

/** True for a split run whose tasks are not all settled: its conflict resolution is checked and reviewed in a round, and it has no checklist to go back to. */
export async function inRound(ctx: ModelStepContext): Promise<boolean> {
  if (!ctx.opened.run.split) return false;
  const tasks = (await ctx.reread(ARTIFACTS.subtasks)) ?? [];
  return tasks.length > 0 && !withStatuses(tasks).every(settled);
}

/** What follows a resolved conflict: the rebased code is checked and reviewed, from the stored implementation. */
export async function resolvedResult(
  deps: RebaseDeps,
  ctx: ModelStepContext,
  mounts: SandboxMount[],
  handoff: string,
): Promise<StepResult> {
  const { key } = ctx.opened.run;
  // The rebased code is checked again before it is reviewed, when the run has the checks phase.
  const next = (await deps.flows.activePhases(ctx.opened.run.id)).includes('checks') ? 'checks' : 'code-review';
  await deps.flows.noteFlow(key, next === 'checks' ? ['checks', 'code-review', 'ci'] : ['code-review', 'ci'], next);
  const tasks = withStatuses((await ctx.reread(ARTIFACTS.subtasks)) ?? []);
  const round = await inRound(ctx);
  const stored = await firstPass(ctx);
  // A split run keeps no implementation of its own until its tasks are settled: its record is the tasks.
  const existing =
    stored ??
    (ctx.opened.run.split && tasks.length > 0 ? { implementation: settledRecord(tasks).lines, summary: [] } : null);
  if (!existing?.implementation.length) {
    throw new SwarmloopError('implementation is missing');
  }
  const body = renderImplementation(existing.implementation);
  const status = await worktreeStatus(mounts);
  return {
    route: { to: 'jump', step: next },
    summary: `${ctx.opened.startedAt} implement done\n${body.trimEnd()}\n${status}`,
    outputs: [
      { artifact: ARTIFACTS.implementation, value: body },
      { artifact: ARTIFACTS.implementationResult, value: existing },
    ],
    handoff,
    visit: {
      documents: [
        textDocument(ARTIFACTS.rebaseConflict.kind, 'review\n'),
        textDocument(ARTIFACTS.rebaseMergeSkip.kind, 'skip\n'),
        ...(round ? [textDocument(ARTIFACTS.epicRound.kind, 'open\n')] : []),
      ],
    },
  };
}

const CONFLICT_ASK = 'conflict-';

/** Whether the planner's answer is to a question askConflict asked, and so belongs to the conflict agent. */
export function answersConflict(answer: PlanChatEntry | null, step: string): answer is PlanChatEntry {
  return answer !== null && answer.key.startsWith(`answer-ask-${step}-${CONFLICT_ASK}`);
}

/**
 * The agent left the same files conflicting: the planner is asked, and the rebase and the marker stay parked for the
 * next visit. A module with no plan chat has no one to ask, and the step fails with the files and git's message.
 */
export function askConflict(
  deps: RebaseDeps,
  ctx: ModelStepContext,
  outcome: Extract<RebaseStop, { kind: 'conflict' }>,
): Promise<StepResult> | StepResult {
  const { run, startedAt, attemptId } = ctx.opened;
  const stderr = outcome.stderr.trim();
  if (!deps.chat) {
    const detail = [outcome.files.join(', '), stderr].filter((part) => part.length > 0).join('\n');
    const line = `${startedAt} ${outcome.repo} rebase failed: ${detail}`;
    return { route: { to: 'fail', error: { code: deps.step, message: line } }, summary: line, outputs: [] };
  }
  const question = [
    `${outcome.repo} still conflicts in ${outcome.files.join(', ')} after the conflict agent's resolution; the rebase stays parked.`,
    ...(stderr ? [stderr] : []),
    'How should these files be resolved?',
  ].join('\n');
  return waitForPlanner(run, {
    chat: deps.chat,
    clock: deps.clock,
    step: deps.step,
    attemptId: `${CONFLICT_ASK}${attemptId}`,
    startedAt,
    question,
  });
}
