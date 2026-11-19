import { closeSync, openSync, readSync, statSync } from 'fs';
import { NotFoundException } from '@nestjs/common';
import type { AppConfig } from '../config/env';
import { pipelineStepOf } from '../contract/steps';
import { knownAttempts, listOutputNames, OUTPUT_STEPS, OutputFiles } from '../core/attempt-output';
import { readCheckOutput } from '../core/check-output';
import type { RunEntity, StepStatEntity } from '../history/entities';
import { redact } from '../config/redact';
import type { CheckCommandRepository } from '../history/check-command.repository';
import type { RunRepository } from '../history/run.repository';
import type { VisitRepository } from '../history/visit.repository';
import { root } from '../history/run-paths';
import { logPaging, requireRun } from './run-queries-run';

/**
 * The output files of one request. The attempt ids the run's stats hold find a visit's file with no listing;
 * `listing` is for a lookup that has no attempt id to start from, which reads the names of `data/` once, asynchronously.
 */
export async function outputsOf(
  config: AppConfig,
  run: RunEntity,
  stats: StepStatEntity[],
  listing: boolean,
): Promise<OutputFiles> {
  const dir = root(config);
  return new OutputFiles(
    dir,
    listing ? { names: await listOutputNames(dir) } : { attempts: knownAttempts(run.activeAttempt, stats) },
  );
}

/** An attempt is known when a stored stat of this step (or its code-review parent), the active attempt, or (for a reviewer, whose own visits store no attempt id) an attempt file of the step names it. */
function knownAttempt(
  outputs: OutputFiles,
  run: RunEntity,
  stats: StepStatEntity[],
  step: string,
  attempt: string,
): boolean {
  const owner = pipelineStepOf(step);
  return (
    (step.startsWith('code-review-') && outputs.attemptIds(run.key, step).includes(attempt)) ||
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

/** The size of a visit's log: its attempt file, or 0 bytes and 0 lines when there is none. */
export function logSize(
  outputs: OutputFiles,
  key: string,
  step: string,
  attemptId: string | null,
): { attemptId: string | null; logBytes: number; logLines: number } {
  const path = attemptId ? outputs.path(key, step, attemptId) : null;
  const file = path ? fileLog(path) : null;
  return { attemptId, logBytes: file?.logBytes ?? 0, logLines: file?.logLines ?? 0 };
}

/**
 * The attempt whose file is a visit's log. A reviewer's own visit stores no attempt id, so its latest visit takes the
 * active attempt while the review runs, else the newest attempt file of the step.
 */
function visitAttempt(
  outputs: OutputFiles,
  run: RunEntity,
  stat: StepStatEntity,
  latest: boolean,
  reviewRunning: boolean,
): string | null {
  if (stat.attemptId || !latest || !stat.step.startsWith('code-review-')) {
    return stat.attemptId;
  }
  return reviewRunning ? run.activeAttempt : (outputs.attemptIds(run.key, stat.step)[0] ?? null);
}

/** The size of a stored visit's log, from its file. */
export function visitLogSize(
  outputs: OutputFiles,
  run: RunEntity,
  step: string,
  stat: StepStatEntity,
  { latest = false, reviewRunning = false } = {},
): ReturnType<typeof logSize> {
  return logSize(outputs, run.key, step, visitAttempt(outputs, run, stat, latest, reviewRunning));
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
  const outputs = await outputsOf(config, run, stats, !attempt || step.startsWith('code-review-'));
  if (attempt && !knownAttempt(outputs, run, stats, step, attempt)) {
    throw new NotFoundException(`${attempt} is not an attempt of ${step}`);
  }
  const text = outputs.path(run.key, step, attempt) ? outputs.read(run.key, step, attempt) : null;
  if (text === null) {
    throw new NotFoundException(`${step} has no log`);
  }
  return sliceLog(redact(text), logPaging(query));
}

/**
 * The full output of one check command, redacted. The attempt (the newest one when none is given) and the index must
 * name a stored command row before a path is built.
 */
export async function readCheckLog(
  runs: RunRepository,
  commands: CheckCommandRepository,
  config: AppConfig,
  key: string,
  attempt: string | null,
  command: string,
  query: { tail?: string; from?: string } = {},
): Promise<string> {
  const run = await requireRun(runs, key);
  const index = /^\d+$/.test(command) ? Number(command) : -1;
  const rows = await commands.list(run.id);
  const attemptId = attempt || rows.at(-1)?.attemptId || '';
  const stored = rows.find((row) => row.attemptId === attemptId && row.commandIndex === index);
  if (!stored) {
    throw new NotFoundException(`${command} is not a check command of ${attemptId || 'this run'}`);
  }
  const text = readCheckOutput(root(config), run.key, 'checks', stored.attemptId, stored.commandIndex);
  if (text === null) {
    throw new NotFoundException(`check command ${command} has no log yet`);
  }
  return sliceLog(redact(text), logPaging(query));
}
