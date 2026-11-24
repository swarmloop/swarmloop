import { agentFor } from '../../config/agents';
import { basename } from 'path';
import type { SwarmloopEnv } from '../../config/env';
import type { EventRepository } from '../../history/event.repository';
import type { DocumentDraft, ExchangeDraft } from '../../history/visit';
import type { PipelineResult } from '../../core/pipeline-result';
import type { OpenedStep } from '../../steps/step-run';
import type { SandboxMount } from '../../core/sandbox-mount';
import type { StepContext } from '../base-step';
import type { Route } from '../contract/step-contract';
import { withReturnNotes } from '../implement/implement-record';
import {
  issueOf,
  returnNotes,
  textDocument,
  withContract,
  withHandoff,
  withImpact,
  withSubtasks,
} from '../shared/handoff';
import { reviewAnswerDefinition, reviewDefinition } from '../../agent-result/definitions/review';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { skillPrompt } from '../shared/skill-prompt';
import { REVIEW_DIFF_READ } from './review-diff';
import type { Requirement } from '../../contract/requirement-list';
import { settled, type Subtask } from '../../contract/subtask';
import type { Issue } from '../contract/step-contract';
import type { KeepLine } from '../shared/keep-lines';
import { SUBTASK_PROOF_CHECK, conflictResolutionSection, exchangeSection } from './code-review.prompts';
import { requirementsSection } from '../shared/coverage-correction';
import { opinionSummary } from './code-review-round-result';
import { reviewDocuments } from './code-review-record';
import type { Opinion } from './code-review-record';
import type { Exchange } from './review-exchange';
import { fixNotes, withKeep } from './review-input';
import { planChangesOf, type PlanChangesSection } from '../shared/plan-changes';
import { requirementsCheck } from './requirements-check';
import { readContract } from '../shared/contract-items';
import { closeReview, recordAngle } from './review-report';
import type { Finished, Reviewer, ReviewDeps, Usage } from './reviewer';
import { projectRules } from '../shared/project-rules';
import { REVIEWERS, runJob } from './reviewer';
import { mayAsk } from '../implement/implement-question';
import { ARTIFACTS, REVIEWS } from '../contract/artifacts';

interface RoundInput {
  opened: OpenedStep;
  key: string;
  env: SwarmloopEnv;
  pending: Reviewer[];
  requirements: string;
  notes: string | null;
  mounts: SandboxMount[];
  handoff: string | null;
  returned: string | null;
  diff: { heading: string; body: string };
  /** The plan as a resumed chat gets it; `coveredPlan` is the one a first prompt gets, with each item's covers. */
  plan: string;
  coveredPlan: string;
  list: Requirement[] | null;
  impact: string | null;
  contract: string | null;
  /** What the starter of a subtask holds as it is now: the task map, the contract, the requirement ids. Empty for a run that is not a subtask. */
  starter: string;
  subtasks: Subtask[] | null;
  keep: KeepLine[] | null;
  /** True while an epic's resolution of its own rebase conflict is being judged. */
  round?: boolean;
  auto: boolean | undefined;
  fresh: boolean;
  retry: boolean;
  exchanges: Map<string, Exchange>;
}

/** Runs every pending angle together, then stores their visits once all of them have finished. */
export async function runRound(deps: ReviewDeps, input: RoundInput): Promise<Finished[]> {
  const documents = await deps.documents.listDocuments(input.opened.run.id);
  const changes = planChangesOf(documents);
  const may = await mayAsk(input.opened.run, deps.chat, { root: deps.root, env: input.env });
  const jobs = input.pending.map((reviewer) => reviewJob(reviewer, input, changes, may));
  const fix = fixNotes(documents, input.handoff);
  const finished = await Promise.all(
    jobs.map((job) =>
      runJob(
        deps,
        input.opened,
        input.key,
        input.env,
        job,
        fix,
        changes ? `${input.plan}\n\n${changes.heading}:\n${changes.body}` : input.plan,
        input.returned,
        input.auto,
        input.fresh,
        input.retry,
      ),
    ),
  );
  for (const item of finished) {
    await recordAngle(deps, input.opened, item);
  }
  return finished;
}

/** Sorts the round's opinions into reviewer order and drafts the documents they are stored with. */
export function tallyRound(
  kept: Opinion[],
  recovered: DocumentDraft[],
  finished: Finished[],
): { reportContinued: boolean; opinions: Opinion[]; stored: DocumentDraft[]; errors: string[] } {
  const reportContinued = finished.some((item) => Boolean(item.result?.chatId));
  const fresh = finished.flatMap((item) => (item.parsed ? [item.parsed] : []));
  const stored = [...recovered, ...fresh.flatMap(reviewDocuments)];
  const opinions = ordered([...kept, ...fresh]);
  const errors = finished.flatMap((item) => (item.error ? [item.error] : []));
  return { reportContinued, opinions, stored, errors };
}

function ordered(opinions: Opinion[]): Opinion[] {
  return REVIEWERS.flatMap((reviewer) => opinions.filter((item) => item.kind === reviewer.kind));
}

export function reportDue(only: string | undefined, kept: Opinion[], pending: Reviewer[]): boolean {
  const covered = new Set([...kept.map((item) => item.kind), ...pending.map((item) => item.kind)]);
  return REVIEWERS.every((reviewer) => covered.has(reviewer.kind));
}

/** The reviewers other than `only` that hold the report back, in reviewer order: no opinion, or a return. */
export function openOthers(only: string, opinions: Opinion[]): { missing: string[]; returned: string[] } {
  const others = REVIEWERS.filter((reviewer) => reviewer.name !== only);
  const answerOf = (reviewer: Reviewer): Opinion | undefined => opinions.find((item) => item.kind === reviewer.kind);
  return {
    missing: others.filter((reviewer) => !answerOf(reviewer)).map((reviewer) => reviewer.name),
    returned: others.filter((reviewer) => answerOf(reviewer)?.decision === 'return').map((reviewer) => reviewer.name),
  };
}

export function othersOpen(only: string, opinions: Opinion[]): boolean {
  const open = openOthers(only, opinions);
  return open.missing.length > 0 || open.returned.length > 0;
}

/** Done when nothing returned or the step is third-party. Otherwise the step goes back to implement. */
export async function routeReview(
  events: EventRepository,
  ctx: StepContext,
  opinions: Opinion[],
  documents: DocumentDraft[],
  exchanges: ExchangeDraft[],
  thirdParty: boolean,
  usage: Usage,
  pass: Route = { to: 'next' },
): Promise<PipelineResult> {
  const { opened } = ctx;
  const summary = opinionSummary(opinions);
  const line = `${opened.startedAt} code-review waiting\n${summary}`;
  const returning = opinions.filter((item) => item.decision === 'return');
  if (returning.length === 0 || thirdParty) {
    return closeReview(ctx, pass, `${opened.startedAt} code-review done\n${summary}`, documents, exchanges, usage);
  }
  const issues = returning.map((item) => {
    const source = item.kind.slice(REVIEWS.prefix.length);
    return issueOf(source, `${source} returned the change`, item.body);
  });
  return returnToImplement(events, ctx, {
    issues,
    kinds: returning.map((item) => item.kind),
    line,
    documents,
    exchanges,
    usage,
  });
}

/** What a round that goes back to implement carries: its issues, who returned, and what the visit stores. */
interface ReturnToImplement {
  issues: Issue[];
  /** The reviews that returned, named in the loop record. */
  kinds: string[];
  line: string;
  documents: DocumentDraft[];
  exchanges: ExchangeDraft[];
  usage?: Usage;
}

/** Counts the return against the loop limit and closes the review as a return to implement with its issues. */
export async function returnToImplement(
  events: EventRepository,
  ctx: StepContext,
  back: ReturnToImplement,
): Promise<PipelineResult> {
  const { opened } = ctx;
  const { issues, kinds, line, documents, exchanges, usage } = back;
  opened.run.attemptsReview += 1;
  await events.recordLoop(opened.run, 'review', opened.run.attemptsReview, kinds.join(','));
  const listed = textDocument(ARTIFACTS.issues.kind, ARTIFACTS.issues.format(issues));
  return closeReview(
    ctx,
    { to: 'return', step: 'implement', issues },
    line,
    [...documents, returnNotes(issues), listed],
    exchanges,
    usage,
  );
}

/** `asks` is true when the reviewer may ask the planner a question: the run has a planner of its own. */
function reviewJob(reviewer: Reviewer, input: RoundInput, changes: PlanChangesSection | null, asks: boolean) {
  const names = input.mounts.map((mount) => basename(mount.hostPath));
  const notesSection = input.notes?.trim() ? [{ heading: 'Implementation', body: input.notes }] : [];
  const listSection = input.list ? [requirementsSection(input.list)] : [];
  const planSection = input.coveredPlan.trim() ? [{ heading: 'Plan', body: input.coveredPlan }] : [];
  const starterSection = input.starter.trim() ? [{ heading: 'Parent run', body: input.starter.trim() }] : [];
  const listed = withSubtasks(
    withContract(
      withImpact(
        withHandoff(
          withReturnNotes(
            [
              input.diff,
              ...notesSection,
              ...listSection,
              ...planSection,
              ...(changes ? [changes] : []),
              ...starterSection,
            ],
            input.returned,
          ),
          input.handoff,
        ),
        input.impact,
      ),
      input.contract,
    ),
    input.subtasks,
    reviewer.name === 'requirements' ? SUBTASK_PROOF_CHECK : undefined,
  );
  const resolution = input.round
    ? [conflictResolutionSection((input.subtasks ?? []).filter((task) => !settled(task)))]
    : [];
  const withRound = [...listed, ...resolution];
  const kept = reviewer.name === 'regressions' ? withKeep(withRound, input.keep) : withRound;
  const exchange = input.exchanges.get(reviewer.name);
  const answered = exchange ? exchangeSection(exchange.finding, exchange.answer) : null;
  const exchanged = answered ? [...kept, answered] : kept;
  // The first prompt of a reviewer's chat carries the whole result text; a resumed chat gets one line in `runJob`.
  const promptFor = (runtime: string): string =>
    [
      skillPrompt(`code-review/${reviewer.name}`, input.requirements, names, exchanged, input.mounts, {
        rules: projectRules(names, input.mounts, runtime, false),
        reads: [REVIEW_DIFF_READ],
      }),
      resultPromptFor(answered ? reviewAnswerDefinition(reviewer.name) : reviewDefinition(reviewer.name), null),
    ].join('\n\n');
  const agent = agentFor(input.env, input.opened.run, 'code-review');
  const itemIds = input.contract
    ? readContract(input.contract)
        .items.map((item) => item.id)
        .filter(Boolean)
    : [];
  const check = input.list && reviewer.name === 'requirements' ? requirementsCheck(input.list, itemIds) : undefined;
  return {
    reviewer,
    ...agent,
    prompt: promptFor(agent.runtime),
    promptFor,
    mounts: input.mounts,
    exchange: answered,
    check,
    mayAsk: asks,
  };
}
