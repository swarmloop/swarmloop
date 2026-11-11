import { closeSync, openSync, readSync, statSync } from 'fs';
import { NotFoundException } from '@nestjs/common';
import type { AppConfig } from '../config/env';
import { pipelineStepOf } from '../contract/steps';
import { attemptIdsOf, OUTPUT_STEPS, stepOutput, stepOutputPath } from '../core/attempt-output';
import { redact } from '../core/redact';
import type { DocumentEntity, RunEntity, StepStatEntity } from '../history/entities';
import type { RunRepository } from '../history/run.repository';
import type { DocumentRepository } from '../history/document.repository';
import type { VisitRepository } from '../history/visit.repository';
import { root } from '../history/run-paths';
import { logPaging, requireRun } from './run-queries-run';

/** An attempt is known when a stored stat of this step (or its code-review parent), the active attempt, or (for a reviewer, whose own visits store no attempt id) an attempt file of the step names it. */
function knownAttempt(dir: string, run: RunEntity, stats: StepStatEntity[], step: string, attempt: string): boolean {
  const owner = pipelineStepOf(step);
  return (
    (step.startsWith('code-review-') && attemptIdsOf(dir, run.key, step).includes(attempt)) ||
    stats.some((stat) => stat.attemptId === attempt && (stat.step === step || stat.step === owner)) ||
    (run.activeAttempt === attempt && (run.currentStep === step || run.currentStep === owner))
  );
}

/** The lines of a log, without the empty piece after the last newline. */
function linesOf(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

interface FileLog {
  mtimeMs: number;
  logBytes: number;
  logLines: number;
}

/** The size of a log file by its modified time, so a run page counts the lines of a 10 MB file once. */
const counted = new Map<string, FileLog>();

/** The lines of a file, counted in chunks so a 10 MB log is never decoded or held whole. Same rule as `linesOf`. */
function countLines(path: string, size: number): number {
  const chunk = Buffer.alloc(64 * 1024);
  const handle = openSync(path, 'r');
  try {
    let newlines = 0;
    let last = 0;
    for (
      let read = readSync(handle, chunk, 0, chunk.length, null);
      read > 0;
      read = readSync(handle, chunk, 0, chunk.length, null)
    ) {
      newlines += chunk.subarray(0, read).filter((byte) => byte === 10).length;
      last = chunk[read - 1];
    }
    return size === 0 || last === 10 ? newlines : newlines + 1;
  } finally {
    closeSync(handle);
  }
}

/** The size of a text held in memory. */
export function textSize(text: string): { logBytes: number; logLines: number } {
  return { logBytes: Buffer.byteLength(text), logLines: linesOf(text).length };
}

function fileLog(path: string): FileLog | null {
  try {
    const { mtimeMs, size } = statSync(path);
    const known = counted.get(path);
    if (known && known.mtimeMs === mtimeMs && known.logBytes === size) {
      return known;
    }
    const entry = { mtimeMs, logBytes: size, logLines: countLines(path, size) };
    counted.set(path, entry);
    return entry;
  } catch {
    return null;
  }
}

/** The size of a visit's log: its attempt file, else the body of a stored `log` document that has no file. */
export function logSize(
  dir: string,
  key: string,
  step: string,
  attemptId: string | null,
  stored = '',
): { attemptId: string | null; logBytes: number; logLines: number } {
  const path = attemptId ? stepOutputPath(dir, key, step, attemptId) : null;
  const file = path ? fileLog(path) : null;
  if (file && file.logBytes > 0) {
    return { attemptId, logBytes: file.logBytes, logLines: file.logLines };
  }
  return { attemptId, ...textSize(stored) };
}

/**
 * The attempt whose file is a visit's log. A reviewer's own visit stores no attempt id, so its latest visit takes the
 * active attempt while the review runs, else the newest attempt file of the step.
 */
function visitAttempt(
  dir: string,
  run: RunEntity,
  stat: StepStatEntity,
  latest: boolean,
  reviewRunning: boolean,
): string | null {
  if (stat.attemptId || !latest || !stat.step.startsWith('code-review-')) {
    return stat.attemptId;
  }
  return reviewRunning ? run.activeAttempt : (attemptIdsOf(dir, run.key, stat.step)[0] ?? null);
}

/** The size of a stored visit's log, from its file, else from the `log` document a visit with no file kept. */
export function visitLogSize(
  config: AppConfig,
  run: RunEntity,
  step: string,
  stat: StepStatEntity,
  documents: DocumentEntity[],
  { latest = false, reviewRunning = false } = {},
): ReturnType<typeof logSize> {
  const dir = root(config);
  const stored = documents.filter((document) => document.stepStatId === stat.id && document.kind === 'log');
  return logSize(dir, run.key, step, visitAttempt(dir, run, stat, latest, reviewRunning), stored.at(-1)?.body ?? '');
}

/** `from` is the first line (1-based). `tail` is how many lines: the last ones, or the ones from `from`. */
function sliceLog(text: string, { tail, from }: { tail?: number; from?: number }): string {
  if (tail === undefined && from === undefined) {
    return text;
  }
  const lines = linesOf(text);
  const start = from === undefined ? Math.max(0, lines.length - (tail ?? 0)) : Math.max(0, from - 1);
  const picked = lines.slice(start, tail === undefined || from === undefined ? undefined : start + tail);
  return picked.map((line) => `${line}\n`).join('');
}

/**
 * The raw log of one attempt of a step, redacted. The run, step and attempt are checked against the list and the history
 * before a path is built, so raw input never forms one.
 */
export async function readStepLog(
  runs: RunRepository,
  visits: VisitRepository,
  documents: DocumentRepository,
  config: AppConfig,
  key: string,
  step: string,
  attempt: string | null,
  query: { tail?: string; from?: string } = {},
): Promise<string> {
  const run = await requireRun(runs, key);
  if (!OUTPUT_STEPS.includes(step)) {
    throw new NotFoundException(`${step} has no log`);
  }
  const stats = await visits.listStats(run.id);
  const dir = root(config);
  if (attempt && !knownAttempt(dir, run, stats, step, attempt)) {
    throw new NotFoundException(`${attempt} is not an attempt of ${step}`);
  }
  const text = stepOutputPath(dir, run.key, step, attempt)
    ? stepOutput(dir, run.key, step, attempt)
    : await storedLog(documents, run, stats, attempt);
  if (text === null) {
    throw new NotFoundException(`${step} has no log`);
  }
  return sliceLog(redact(text, config.env), logPaging(query));
}

/** The `log` document a visit kept when it had no file. Null when there is none. */
async function storedLog(
  documents: DocumentRepository,
  run: RunEntity,
  stats: StepStatEntity[],
  attempt: string | null,
): Promise<string | null> {
  const stat = attempt ? stats.find((item) => item.attemptId === attempt) : undefined;
  if (!stat) {
    return null;
  }
  const stored = (await documents.listDocuments(run.id)).filter(
    (document) => document.stepStatId === stat.id && document.kind === 'log' && document.body !== '',
  );
  return stored.length > 0 ? stored[stored.length - 1].body : null;
}
