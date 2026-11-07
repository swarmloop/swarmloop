import { Logger } from '@nestjs/common';
import type { StepName } from '../../contract/steps';
import { requirementsView } from '../../contract/requirements-view';
import { withoutTimestamp } from '../../contract/event-text';
import { isStopNote } from '../../contract/run-state';
import type { AttemptFacts, StepEvent } from '../../contract/step-events';
import { redact } from '../../core/redact';
import type { DocumentRepository } from '../../history/document.repository';
import type { StepEventLog } from '../../history/step-event.log';
import type { DocumentDraft } from '../../history/visit';
import type { Artifact } from '../contract/artifact';
import { firstLine } from '../contract/artifact';
import { ARTIFACTS, REVIEWS, summarizePlan, summarizeReview } from '../contract/artifacts';
import type { InputSpec, Issue } from '../contract/step-contract';
import { recordStepEvent } from '../../core/step-event-scope';

/** The steps whose pass closes the issues they opened. */
const RESOLVING_STEPS: StepName[] = ['code-review', 'pipeline'];

/** One line that tells what a stored document holds. A step that revises the plan is named by its checklist. */
function documentSummary(kind: string, body: string, step: StepName): string {
  if (REVIEWS.matches(kind)) {
    return summarizeReview(body);
  }
  if (kind === ARTIFACTS.requirements.kind && (step === 'plan' || step === 'plan-improve')) {
    const plan = summarizePlan(body);
    if (plan) {
      return plan;
    }
  }
  const entry: Artifact<unknown> | undefined = Object.values<Artifact<unknown>>(ARTIFACTS).find(
    (item) => item.kind === kind,
  );
  try {
    return entry ? entry.summarize(entry.parse(body)) : firstLine(body);
  } catch {
    return firstLine(body);
  }
}

/** Stores an event of a step. A failed write is logged and never thrown, so it cannot fail the step. */
export function stepEventSink(log: StepEventLog, env: object): (event: StepEvent) => Promise<void> {
  return async (event) => {
    try {
      await log.append([event]);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      new Logger('StepEvents').error(`${event.kind} of ${event.step} was not recorded: ${redact(text, env)}`);
    }
  };
}

/** One `input.received` for each input the step read, with the document it got. A step that reads issues also records the handoff it took, once. */
export async function recordInputs(
  documents: DocumentRepository,
  log: StepEventLog,
  runId: number,
  step: StepName,
  spec: InputSpec,
  input: Record<string, unknown>,
  latestIssues: () => Promise<Issue[] | null>,
): Promise<void> {
  const read = Object.entries(spec).filter(([, entry]) => !entry.late);
  const ids = await documents.latestIds(
    runId,
    read.map(([, entry]) => entry.artifact.kind),
  );
  for (const [name, entry] of read) {
    const kind = entry.artifact.kind;
    const value = input[name];
    const present = value !== null && value !== undefined;
    const view =
      present && kind === ARTIFACTS.requirements.kind ? requirementsView(typeof value === 'string' ? value : '') : null;
    recordStepEvent({
      kind: 'input.received',
      name,
      inputKind: kind,
      documentId: ids.get(kind) ?? 'absent',
      summary: present ? entry.artifact.summarize(value) : 'absent',
      ...(view ? { meta: [view.meta, view.approval].filter(Boolean).join(' · ') } : {}),
    });
  }
  if (Object.values(spec).some((entry) => entry.artifact.kind === ARTIFACTS.issues.kind)) {
    await recordHandoffReceived(documents, log, runId, step, latestIssues);
  }
}

async function recordHandoffReceived(
  documents: DocumentRepository,
  log: StepEventLog,
  runId: number,
  step: StepName,
  latestIssues: () => Promise<Issue[] | null>,
): Promise<void> {
  const handoffId = (await documents.latestIds(runId, [ARTIFACTS.handoff.kind])).get(ARTIFACTS.handoff.kind);
  if (handoffId === undefined || (await log.hasReceived(runId, step, handoffId))) {
    return;
  }
  const issues = (await latestIssues()) ?? [];
  const issueIds = issues.map((issue) => issue.id);
  if (issueIds.length > 0) {
    const from = [...new Set(issues.map((issue) => issue.source))].join(', ');
    recordStepEvent({ kind: 'handoff.received', handoffId, issueIds, from });
  }
}

interface StepEndFacts {
  runId: number;
  step: StepName;
  attemptId: string;
  outcome: string;
  moveTo?: StepName;
  line: string;
  issues: Issue[];
  /** The documents the visit stored. */
  stored: DocumentDraft[];
  /** The step the run goes to when this attempt ended well. Null when it stays. */
  target: StepName | null;
  facts?: AttemptFacts;
}

/** What a closed visit produced and sent on, ending with `attempt.finished`. */
export async function recordEnd(documents: DocumentRepository, log: StepEventLog, end: StepEndFacts): Promise<void> {
  if (RESOLVING_STEPS.includes(end.step) && end.outcome === 'ok' && end.moveTo === undefined) {
    const now = new Set(end.issues.map((issue) => issue.id));
    for (const issueId of (await log.openIssues(end.runId, end.step)).filter((id) => !now.has(id))) {
      recordStepEvent({ kind: 'issue.resolved', issueId, evidence: `${end.step} ${end.attemptId}` });
    }
  }
  for (const issue of end.issues) {
    recordStepEvent({
      kind: 'issue.opened',
      issueId: issue.id,
      source: issue.source,
      title: issue.title,
      line: firstLine(issue.body),
      returnedTo: end.moveTo ?? null,
    });
  }
  const ids = await documents.latestIds(
    end.runId,
    end.stored.map((document) => document.kind),
  );
  const handoffKind = ARTIFACTS.handoff.kind;
  const artifacts = end.stored.filter((document) => document.kind !== handoffKind);
  const artifactKinds = artifacts.map((document) => document.kind);
  const summaries = artifacts.map((document) => documentSummary(document.kind, document.body, end.step));
  artifacts.forEach((document, index) => {
    recordStepEvent({
      kind: 'artifact.produced',
      artifactKind: document.kind,
      documentId: ids.get(document.kind) ?? 0,
      summary: summaries[index],
    });
  });
  const handoffId = ids.get(handoffKind);
  if (handoffId !== undefined && end.stored.some((document) => document.kind === handoffKind)) {
    recordStepEvent({
      kind: 'handoff.sent',
      handoffId,
      targetStep: end.target,
      artifactKinds,
      issueIds: end.issues.map((issue) => issue.id),
      summaries,
    });
  }
  if (isStopNote(end.line)) {
    recordStepEvent({ kind: 'attempt.interrupted', route: 'stopped', summary: withoutTimestamp(end.line) });
    return;
  }
  recordStepEvent({
    kind: 'attempt.finished',
    route: end.moveTo ?? end.outcome,
    summary: withoutTimestamp(end.line),
    ...(end.facts ? { facts: end.facts } : {}),
  });
}
