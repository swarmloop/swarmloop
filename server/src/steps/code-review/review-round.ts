import { agentFor } from '../../config/agents';
import { readFileSync } from 'fs';
import { basename, join } from 'path';
import type { SwarmloopEnv } from '../../config/env';
import type { EventRepository } from '../../history/event.repository';
import type { DocumentDraft, ExchangeDraft } from '../../history/visit';
import type { PipelineResult } from '../../core/pipeline-result';
import type { OpenedStep } from '../../steps/step-run';
import type { SandboxMount } from '../../core/sandbox-mount';
import { agentStateDir } from '../../sandbox/sandbox-launch';
import type { StepContext } from '../base-step';
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
import { reviewDefinition } from '../../agent-result/definitions/review';
import { resultPromptFor } from '../../agent-result/result-prompt';
import { skillPrompt } from '../shared/skill-prompt';
import type { Subtask } from '../../contract/subtask';
import type { KeepLine } from '../shared/keep-lines';
import { SUBTASK_PROOF_CHECK } from './code-review.prompts';
import { opinionSummary } from './code-review-round-result';
import { decidedOk, reviewDocuments } from './code-review-record';
import type { Opinion } from './code-review-record';
import { fixNotes, withKeep } from './review-input';
import { closeReview, recordAngle } from './review-report';
import type { Finished, Reviewer, ReviewDeps, Usage } from './reviewer';
import { projectRules } from '../shared/project-rules';
import { REVIEWERS, runJob } from './reviewer';
import { ARTIFACTS, REVIEWS } from '../contract/artifacts';

interface RoundInput {
  opened: OpenedStep;
  key: string;
  env: SwarmloopEnv;
  pending: Reviewer[];
  stale: Set<string>;
  requirements: string;
  notes: string | null;
  mounts: SandboxMount[];
  handoff: string | null;
  returned: string | null;
  diff: { heading: string; body: string };
  plan: string;
  impact: string | null;
  contract: string | null;
  subtasks: Subtask[] | null;
  keep: KeepLine[] | null;
  auto: boolean | undefined;
  fresh: boolean;
  retry: boolean;
  repeated: boolean;
}

/** Runs every pending angle together, then stores their visits once all of them have finished. */
export async function runRound(deps: ReviewDeps, input: RoundInput): Promise<Finished[]> {
  const documents = await deps.documents.listDocuments(input.opened.run.id);
  const jobs = input.pending.map((reviewer) => ({
    ...reviewJob(reviewer, input),
    stale: input.stale.has(reviewer.name),
  }));
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
        input.plan,
        input.returned,
        input.auto,
        input.fresh,
        input.retry,
      ),
    ),
  );
  for (const item of finished) {
    await recordAngle(deps, input.opened, item, input.repeated);
  }
  return finished;
}

export function reviewReturn(returned: string | null): boolean {
  if (!returned?.trim()) {
    return false;
  }
  const lines = returned.split(/\r?\n/).map((line) => line.trim());
  return !(lines.includes('## pipeline') && lines.includes('result: fail'));
}

export function sameReviewedDiff(root: string, key: string, patch: string): boolean {
  try {
    const previous = readFileSync(
      join(agentStateDir(root, key, 'code-review-requirements'), 'briefs', 'diff.md'),
      'utf8',
    );
    return previous === patch;
  } catch {
    return false;
  }
}

/** Sorts the round's opinions into reviewer order and drafts the documents they are stored with. */
export function tallyRound(
  kept: Opinion[],
  recovered: DocumentDraft[],
  finished: Finished[],
  repeated: boolean,
): { reportContinued: boolean; opinions: Opinion[]; stored: DocumentDraft[]; errors: string[] } {
  const reportContinued = finished.some((item) => Boolean(item.result?.chatId));
  const accepted = (opinion: Opinion): Opinion =>
    repeated && opinion.decision === 'return' ? decidedOk(opinion) : opinion;
  const fresh = finished.flatMap((item) => (item.parsed ? [accepted(item.parsed)] : []));
  const stored = [...recovered, ...fresh.flatMap(reviewDocuments)];
  const opinions = ordered([...kept.map(accepted), ...fresh]);
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

export function othersOpen(only: string, opinions: Opinion[]): boolean {
  return REVIEWERS.some((reviewer) => {
    if (reviewer.name === only) {
      return false;
    }
    const opinion = opinions.find((item) => item.kind === reviewer.kind);
    return !opinion || opinion.decision === 'return';
  });
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
): Promise<PipelineResult> {
  const { opened } = ctx;
  const summary = opinionSummary(opinions);
  const line = `${opened.startedAt} code-review waiting\n${summary}`;
  const returning = opinions.filter((item) => item.decision === 'return');
  if (returning.length === 0 || thirdParty) {
    return closeReview(
      ctx,
      { to: 'next' },
      `${opened.startedAt} code-review done\n${summary}`,
      documents,
      exchanges,
      usage,
    );
  }
  opened.run.attemptsReview += 1;
  await events.recordLoop(
    opened.run,
    'review',
    opened.run.attemptsReview,
    returning.map((item) => item.kind).join(','),
  );
  const report = documents.find((item) => item.kind === ARTIFACTS.reviewReport.kind)?.body.trim();
  const issues = returning.map((item) => {
    const source = item.kind.slice(REVIEWS.prefix.length);
    return issueOf(source, `${source} returned the change`, item.body);
  });
  const leftover = report
    ? textDocument(ARTIFACTS.return.kind, report.endsWith('\n') ? report : `${report}\n`)
    : returnNotes(issues);
  const listed = textDocument(ARTIFACTS.issues.kind, ARTIFACTS.issues.format(issues));
  return closeReview(
    ctx,
    { to: 'return', step: 'implement', issues },
    line,
    [...documents, leftover, listed],
    exchanges,
    usage,
  );
}

function reviewJob(reviewer: Reviewer, input: RoundInput) {
  const names = input.mounts.map((mount) => basename(mount.hostPath));
  const notesSection = input.notes?.trim() ? [{ heading: 'Implementation', body: input.notes }] : [];
  const planSection = input.plan.trim() ? [{ heading: 'Plan', body: input.plan }] : [];
  const listed = withSubtasks(
    withContract(
      withImpact(
        withHandoff(withReturnNotes([input.diff, ...notesSection, ...planSection], input.returned), input.handoff),
        input.impact,
      ),
      input.contract,
    ),
    input.subtasks,
    reviewer.name === 'requirements' ? SUBTASK_PROOF_CHECK : undefined,
  );
  const sections = reviewer.name === 'regressions' ? withKeep(listed, input.keep) : listed;
  // The first prompt of a reviewer's chat carries the whole result text; a resumed chat gets one line in `runJob`.
  const promptFor = (runtime: string): string =>
    [
      skillPrompt(`code-review/${reviewer.name}`, input.requirements, names, sections, input.mounts, {
        rules: projectRules(names, input.mounts, runtime, false),
      }),
      resultPromptFor(reviewDefinition(reviewer.name), null),
    ].join('\n\n');
  const agent = agentFor(input.env, input.opened.run, 'code-review');
  return { reviewer, ...agent, prompt: promptFor(agent.runtime), promptFor, mounts: input.mounts };
}
