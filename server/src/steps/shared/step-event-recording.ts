import { Logger } from '@nestjs/common';
import type { StepName } from '../../contract/steps';
import type { StepEvent } from '../../contract/step-events';
import { redact } from '../../core/redact';
import type { DocumentRepository } from '../../history/document.repository';
import type { StepEventLog } from '../../history/step-event.log';
import type { DocumentDraft } from '../../history/visit';
import { ARTIFACTS } from '../contract/artifacts';
import type { InputSpec, Issue } from '../contract/step-contract';
import { recordStepEvent } from '../../core/step-event-scope';

const SUMMARY_CHARS = 120;

/** The first non-empty line of a document, cut short. */
function oneLine(body: string): string {
  const line = body.split('\n').find((item) => item.trim() !== '') ?? '';
  return line.trim().slice(0, SUMMARY_CHARS);
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

/** One `input.received` for each input the step read, with the document it got. */
export async function recordInputs(
  documents: DocumentRepository,
  runId: number,
  spec: InputSpec,
  input: Record<string, unknown>,
): Promise<void> {
  const read = Object.entries(spec).filter(([, entry]) => !entry.late);
  const ids = await documents.latestIds(
    runId,
    read.map(([, entry]) => entry.artifact.kind),
  );
  for (const [name, entry] of read) {
    const kind = entry.artifact.kind;
    const value = input[name];
    recordStepEvent({
      kind: 'input.received',
      name,
      inputKind: kind,
      documentId: ids.get(kind) ?? 'absent',
      summary: value === null || value === undefined ? 'absent' : oneLine(entry.artifact.format(value)),
    });
  }
}

interface StepEndFacts {
  runId: number;
  outcome: string;
  moveTo?: StepName;
  line: string;
  issues: Issue[];
  /** The documents the visit stored. */
  stored: DocumentDraft[];
}

/** What a closed visit produced and sent on, ending with `attempt.finished`. */
export async function recordEnd(documents: DocumentRepository, end: StepEndFacts): Promise<void> {
  for (const issue of end.issues) {
    recordStepEvent({ kind: 'issue.opened', issueId: issue.id, source: issue.source, title: issue.title });
  }
  const ids = await documents.latestIds(
    end.runId,
    end.stored.map((document) => document.kind),
  );
  const handoffKind = ARTIFACTS.handoff.kind;
  const artifactKinds = end.stored.map((document) => document.kind).filter((kind) => kind !== handoffKind);
  for (const kind of artifactKinds) {
    recordStepEvent({ kind: 'artifact.produced', artifactKind: kind, documentId: ids.get(kind) ?? 0 });
  }
  const handoffId = ids.get(handoffKind);
  if (handoffId !== undefined && end.stored.some((document) => document.kind === handoffKind)) {
    recordStepEvent({
      kind: 'handoff.sent',
      handoffId,
      targetStep: end.moveTo ?? null,
      artifactKinds,
      issueIds: end.issues.map((issue) => issue.id),
    });
  }
  recordStepEvent({ kind: 'attempt.finished', route: end.moveTo ?? end.outcome, summary: end.line });
}
