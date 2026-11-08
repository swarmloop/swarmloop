import { readFileSync } from 'fs';
import { basename, join } from 'path';
import type { SwarmloopEnv } from '../../config/env';
import { stepOutput } from '../../core/attempt-output';
import type { DocumentRepository } from '../../history/document.repository';
import type { EventRepository } from '../../history/event.repository';
import type { DocumentDraft, ExchangeDraft } from '../../history/visit';
import type { PipelineResult } from '../../core/pipeline-result';
import type { OpenedStep } from '../../steps/step-run';
import type { SandboxMount } from '../../core/sandbox-mount';
import { agentStateDir } from '../../sandbox/sandbox-launch';
import type { StepContext } from '../base-step';
import { withReturnNotes } from '../implement/implement-record';
import { issueOf, returnNotes, textDocument, withHandoff, withImpact } from '../shared/handoff';
import { skillPrompt } from '../shared/skill-prompt';
import { parseReview } from './code-review-record';
import { fixNotes } from './review-input';
import { closeReview, recordAngle } from './review-report';
import type { Finished, Opinion, Reviewer, ReviewDeps, Usage } from './reviewer';
import { decidedOk, reviewModel, REVIEWERS, runJob } from './reviewer';
import { ARTIFACTS, REVIEWS } from '../contract/artifacts';

interface Selection {
  kept: Opinion[];
  pending: Reviewer[];
  recovered: DocumentDraft[];
  stale: Set<string>;
}

interface SelectInput {
  key: string;
  only: string | undefined;
  fresh: boolean;
  retry: boolean;
  /** The attempt of the code-review visit that was interrupted. Set when `retry`. */
  attemptId: string | null;
  same: boolean;
  repeated: boolean;
  /** Whether the stored review `kind` counts for this generation and these files. */
  counts: (kind: string) => Promise<boolean>;
}

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
  auto: boolean | undefined;
  fresh: boolean;
  retry: boolean;
  repeated: boolean;
}

export async function selectReviewers(
  documents: DocumentRepository,
  root: string,
  input: SelectInput,
): Promise<Selection> {
  const { key, only, fresh, retry, attemptId, same, repeated, counts } = input;
  const kept: Opinion[] = [];
  const pending: Reviewer[] = [];
  const recovered: DocumentDraft[] = [];
  const stale = new Set<string>();
  for (const reviewer of REVIEWERS) {
    if (fresh) {
      if (!only || only === reviewer.name) {
        pending.push(reviewer);
      }
      continue;
    }
    if (only === reviewer.name) {
      pending.push(reviewer);
      continue;
    }
    const stored =
      !fresh && (Boolean(only) || retry || same) && (await counts(reviewer.kind))
        ? await documents.latestBody(key, reviewer.kind)
        : null;
    if (stored) {
      try {
        const parsed = parseReview(stored);
        if (staleReturn(repeated, parsed.decision)) {
          stale.add(reviewer.name);
        } else if (only || retry || parsed.decision === 'ok') {
          kept.push({ kind: reviewer.kind, decision: parsed.decision, body: stored });
          continue;
        }
      } catch {
        // launch or leave open
      }
    }
    if (retry && !only) {
      try {
        const parsed = parseReview(stepOutput(root, key, `code-review-${reviewer.name}`, attemptId));
        if (staleReturn(repeated, parsed.decision)) {
          stale.add(reviewer.name);
        } else {
          kept.push({ kind: reviewer.kind, decision: parsed.decision, body: parsed.body });
          recovered.push(textDocument(reviewer.kind, parsed.body));
          continue;
        }
      } catch {
        // launch this reviewer again
      }
    }
    if (!only) {
      pending.push(reviewer);
    }
  }
  return { kept, pending, recovered, stale };
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

function acceptRepeated(documents: DocumentDraft[], opinions: Opinion[]): DocumentDraft[] {
  const kinds = new Set(opinions.filter((item) => item.decision === 'return').map((item) => item.kind));
  return documents.map((document) =>
    kinds.has(document.kind) ? { ...document, body: decidedOk(document.body) } : document,
  );
}

/** Sorts the round's opinions into reviewer order and drafts the documents they are stored with. */
export function tallyRound(
  kept: Opinion[],
  recovered: DocumentDraft[],
  finished: Finished[],
  repeated: boolean,
): { reportContinued: boolean; opinions: Opinion[]; stored: DocumentDraft[]; errors: string[] } {
  const reportContinued = finished.some((item) => Boolean(item.result?.chatId));
  const drafted = [
    ...recovered,
    ...finished.flatMap((item) => (item.parsed ? [textDocument(item.reviewer.kind, item.parsed.body)] : [])),
  ];
  const found = ordered([...kept, ...finished.flatMap((item) => (item.parsed ? [item.parsed] : []))]);
  const opinions = repeated
    ? found.map((item) =>
        item.decision === 'return' ? { ...item, decision: 'ok' as const, body: decidedOk(item.body) } : item,
      )
    : found;
  const stored = repeated ? acceptRepeated(drafted, found) : drafted;
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
  const summary = opinions.map((item) => `${item.kind} ${item.decision}`).join('\n');
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

function staleReturn(repeated: boolean, decision: 'ok' | 'return'): boolean {
  return repeated && decision === 'return';
}

function reviewJob(reviewer: Reviewer, input: RoundInput) {
  const names = input.mounts.map((mount) => basename(mount.hostPath));
  const notesSection = input.notes?.trim() ? [{ heading: 'Implementation', body: input.notes }] : [];
  const planSection = input.plan.trim() ? [{ heading: 'Plan', body: input.plan }] : [];
  const sections = withImpact(
    withHandoff(withReturnNotes([input.diff, ...notesSection, ...planSection], input.returned), input.handoff),
    input.impact,
  );
  return {
    reviewer,
    model: reviewModel(input.env),
    prompt: skillPrompt(`code-review/${reviewer.name}`, input.requirements, names, sections, input.mounts),
    mounts: input.mounts,
  };
}
