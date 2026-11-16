import { CODE_REVIEWERS } from '../../contract/steps';
import type { Requirement } from '../../contract/requirement-list';
import type { Clock } from '../../core/clock';
import type { ReviewResult } from '../../agent-result/definitions/review';
import { storedReview } from '../../agent-result/stored-review';
import type { CheckCommandRepository } from '../../history/check-command.repository';
import type { DocumentRepository } from '../../history/document.repository';
import type { FlowRepository } from '../../history/flow.repository';
import type { RunEntity } from '../../history/entities';
import type { VisitRepository } from '../../history/visit.repository';
import { ARTIFACTS } from '../contract/artifacts';
import { reportExchanges, type ReportExchange } from './report-exchange';
import { reportPath, returnCount, type PathStep } from './report-path';
import { readStored } from './report-stored';

export type { PathStep } from './report-path';

export type Verdict = 'ready' | 'waiting' | 'sent-back' | 'ci-failed';

/** What one reviewer decided, and the finding implement did not fix when the run has one. */
export interface ReviewerFact {
  name: (typeof CODE_REVIEWERS)[number];
  decision: 'ok' | 'return' | null;
  exchange: ReportExchange | null;
}

/** A review of the round being written, which is not stored yet. */
export interface RoundReview {
  name: string;
  result: ReviewResult;
}

/** What the server knows of a run for its report. A fact it cannot read is null and shows as `—`. */
export interface ReportFacts {
  verdict: Verdict;
  requirements: { met: number; total: number } | null;
  checks: { passed: number; total: number } | null;
  ci: 'passed' | 'failed' | 'waiting' | null;
  review: { ok: number; total: number } | null;
  returns: { count: number; fixed: boolean };
  minutes: number | null;
  path: PathStep[];
  reviewers: ReviewerFact[];
  /** Set only for a split parent. */
  tasks?: { merged: number; total: number } | null;
}

export interface ReportFactsDeps {
  documents: DocumentRepository;
  visits: VisitRepository;
  flows: FlowRepository;
  checkCommands: CheckCommandRepository;
  clock: Clock;
}

interface StoredDocument {
  stepStatId: number;
  kind: string;
  body: string;
}

const MINUTE_MS = 60_000;

function latest(documents: StoredDocument[], kind: string): StoredDocument | undefined {
  return [...documents].reverse().find((document) => document.kind === kind);
}

function requirementsFact(
  documents: StoredDocument[],
  marks: ReviewResult['requirements'],
): ReportFacts['requirements'] {
  const stored = latest(documents, ARTIFACTS.requirementList.kind);
  const list: Requirement[] | null = stored ? readStored(() => ARTIFACTS.requirementList.parse(stored.body)) : null;
  if (!list || list.length === 0 || !marks) {
    return null;
  }
  const met = list.filter((item) => marks.some((mark) => mark.id === item.id && mark.status === 'met')).length;
  return { met, total: list.length };
}

async function checksFact(deps: ReportFactsDeps, runId: number): Promise<ReportFacts['checks']> {
  const rows = await deps.checkCommands.list(runId);
  const attempt = rows.at(-1)?.attemptId;
  const counted = rows.filter((row) => row.attemptId === attempt && !row.skipped);
  return counted.length > 0
    ? { passed: counted.filter((row) => row.status === 'passed').length, total: counted.length }
    : null;
}

/** CI as of the last pipeline log written after the last review. A round being written has none yet. */
function ciFact(
  documents: StoredDocument[],
  reviewVisit: number,
  phases: readonly string[],
  inRound: boolean,
): ReportFacts['ci'] {
  const log = inRound ? undefined : latest(documents, ARTIFACTS.pipelineLog.kind);
  // The registry reads the labels of its own log: `pass`, `fail: <job>`, or the first line of any other.
  const result = log && log.stepStatId > reviewVisit ? ARTIFACTS.pipelineLog.summarize(log.body) : '';
  if (result === 'pass') {
    return 'passed';
  }
  if (result.startsWith('fail')) {
    return 'failed';
  }
  return phases.includes('ci') ? 'waiting' : null;
}

function verdictOf(reviewers: ReviewerFact[], ci: ReportFacts['ci']): Verdict {
  if (reviewers.some((reviewer) => reviewer.decision === 'return')) {
    return 'sent-back';
  }
  return ci === 'failed' ? 'ci-failed' : ci === 'waiting' ? 'waiting' : 'ready';
}

/**
 * The facts of a run's report, from its stored documents and visits. `round` holds the reviews of a round whose
 * documents are not stored yet; they stand in for the stored ones.
 */
export async function readReportFacts(
  deps: ReportFactsDeps,
  run: RunEntity,
  round: RoundReview[] = [],
): Promise<ReportFacts> {
  const documents = await deps.documents.listDocuments(run.id);
  const stats = await deps.visits.listStats(run.id);
  const phases = await deps.flows.activePhases(run.id);
  const exchanges = reportExchanges(documents);
  const decided = (name: string): ReviewResult | null =>
    round.find((item) => item.name === name)?.result ?? readStored(() => storedReview(name, documents));
  const reviewers = CODE_REVIEWERS.map((name): ReviewerFact => {
    const decision = decided(name)?.decision ?? null;
    return { name, decision, exchange: decision === 'return' ? (exchanges.get(name) ?? null) : null };
  });
  const decisions = reviewers.filter((reviewer) => reviewer.decision !== null);
  const reviewVisit = [...stats].reverse().find((stat) => stat.step === 'code-review')?.id ?? 0;
  const ci = ciFact(documents, reviewVisit, phases, round.length > 0);
  const path = reportPath(stats, documents);
  const end = run.doneAt ? Date.parse(run.doneAt) : deps.clock.now();
  const start = Date.parse(run.createdAt);
  return {
    verdict: verdictOf(reviewers, ci),
    requirements: requirementsFact(documents, decided('requirements')?.requirements),
    checks: await checksFact(deps, run.id),
    ci,
    review:
      decisions.length > 0
        ? { ok: decisions.filter((reviewer) => reviewer.decision === 'ok').length, total: decisions.length }
        : null,
    returns: returnCount(path),
    minutes: Number.isNaN(start) || Number.isNaN(end) ? null : Math.max(0, Math.round((end - start) / MINUTE_MS)),
    path,
    reviewers,
  };
}
