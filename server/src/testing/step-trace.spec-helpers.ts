import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DataSource } from 'typeorm';
import type { DocumentRepository } from '../history/document.repository';
import {
  AgentExchangeEntity,
  DocumentEntity,
  FlowEntity,
  HttpCallEntity,
  LoopEventEntity,
  RunEntity,
  StepStatEntity,
} from '../history/entities';

export const GOLDEN_DIR = join(__dirname, 'golden');

export type RecordingDocuments = DocumentRepository & { readonly kinds: string[] };

const KIND_AT_ARGUMENT_ONE = new Set(['latestBody', 'latestDocument', 'hasDocument', 'putDocument']);

/** A proxy over the repository that notes every kind it is asked for, without changing a result. `*` stands for a listing. */
export function recordingDocuments(documents: DocumentRepository): RecordingDocuments {
  const kinds: string[] = [];
  return new Proxy(documents, {
    get(target, property) {
      if (property === 'kinds') return kinds;
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]): unknown => {
        if (property === 'listDocuments') kinds.push('*');
        else if (typeof property === 'string' && KIND_AT_ARGUMENT_ONE.has(property)) kinds.push(String(args[1]));
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as RecordingDocuments;
}

/** The observable result of a run as plain JSON: no timestamps, no pid. `reads` maps a step to the kinds it read. */
export async function traceRun(dataSource: DataSource, key: string, reads: Record<string, string[]>) {
  const run = await dataSource.getRepository(RunEntity).findOneByOrFail({ key });
  const runId = run.id;
  const byRun = { where: { runId }, order: { id: 'ASC' as const } };
  const documents = await dataSource.getRepository(DocumentEntity).find(byRun);
  const visits = [];
  for (const stat of await dataSource.getRepository(StepStatEntity).find(byRun)) {
    const byStat = { where: { stepStatId: stat.id }, order: { id: 'ASC' as const } };
    visits.push({
      step: stat.step,
      status: stat.status,
      exitCode: stat.exitCode,
      model: stat.model,
      mode: stat.mode,
      killReason: stat.killReason,
      tokensIn: stat.tokensIn,
      tokensOut: stat.tokensOut,
      usd: stat.usd,
      resumed: stat.resumed === 1,
      documents: documents.filter((d) => d.stepStatId === stat.id).map(({ kind, body }) => ({ kind, body })),
      httpCalls: (await dataSource.getRepository(HttpCallEntity).find(byStat)).map(({ method, url, statusCode }) => ({
        method,
        url,
        statusCode,
      })),
      exchanges: (await dataSource.getRepository(AgentExchangeEntity).find(byStat)).map(
        ({ model, requestText, responseText, chatId }) => ({ model, requestText, responseText, chatId }),
      ),
    });
  }
  return {
    run: {
      status: run.status,
      currentStep: run.currentStep,
      attemptsReview: run.attemptsReview,
      attemptsQa: run.attemptsQa,
      attemptsPipeline: run.attemptsPipeline,
      agentCalls: run.agentCalls,
      spentUsd: run.spentUsd,
      runtime: run.runtime,
    },
    visits,
    documentsOutsideVisits: documents.filter((d) => d.stepStatId === 0).map(({ kind, body }) => ({ kind, body })),
    flows: (await dataSource.getRepository(FlowEntity).find(byRun)).map(({ phases, fromStep }) => ({
      phases,
      fromStep,
    })),
    loopEvents: (await dataSource.getRepository(LoopEventEntity).find(byRun)).map(({ counter, attempt, reason }) => ({
      counter,
      attempt,
      reason,
    })),
    reads: Object.fromEntries(Object.entries(reads).map(([step, kinds]) => [step, [...new Set(kinds)]])),
  };
}

const TIMESTAMP = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ERROR_ID = /\bE-[0-9a-z]{8}\b/g;
const SHA = /\b[0-9a-f]{40}\b/g;
const MOUNT = /(?<![\w.<>-])\/work\//g;
const DURATION = /\b\d+(?:\.\d+)?\s?ms\b/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replaces what changes between runs: timestamps, temp directories, the `/work` sandbox mount, SHAs, durations, random ids. */
export function normalizeTrace<T>(value: T): T {
  const shas = new Map<string, number>();
  const ids = new Map<string, number>();
  const numbered = (seen: Map<string, number>, label: string) => (found: string) => {
    if (!seen.has(found)) seen.set(found, seen.size + 1);
    return `<${label}:${seen.get(found)}>`;
  };
  const temp = new RegExp(`${escapeRegExp(tmpdir())}/[^/\\s"'\`:]+`, 'g');
  const text = (input: string): string =>
    input
      .replace(temp, '<root>')
      .replace(MOUNT, '<work>/')
      .replace(TIMESTAMP, '<t>')
      .replace(UUID, numbered(ids, 'id'))
      .replace(ERROR_ID, numbered(ids, 'id'))
      .replace(SHA, numbered(shas, 'sha'))
      .replace(DURATION, '<ms>');
  const walk = (node: unknown, key?: string): unknown => {
    if (typeof node === 'string') return text(node);
    if (typeof node === 'number' && key === 'durationMs') return '<ms>';
    if (typeof node === 'number' && !Number.isInteger(node)) return Math.round(node * 1e6) / 1e6;
    if (Array.isArray(node)) return node.map((item) => walk(item));
    if (node !== null && typeof node === 'object') {
      const entries = Object.entries(node).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return Object.fromEntries(entries.map(([k, v]) => [text(k), walk(v, k)]));
    }
    return node;
  };
  return walk(value) as T;
}

function sorted(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(sorted);
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, sorted(v)]),
    );
  }
  return node;
}

/** Compares a trace with `golden/<name>.json`. `UPDATE_GOLDEN=1` writes it, except when `CI` is set. The comparison ignores layout, so a prettier pass over the goldens is safe. */
export function expectGolden(name: string, trace: unknown, dir: string = GOLDEN_DIR): void {
  const file = join(dir, `${name}.json`);
  const actual = `${JSON.stringify(sorted(normalizeTrace(trace)), null, 2)}\n`;
  if (process.env.UPDATE_GOLDEN === '1' && !process.env.CI) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  if (!existsSync(file)) {
    throw new Error(`golden file ${file} is missing; run the spec with UPDATE_GOLDEN=1 outside CI`);
  }
  expect(JSON.parse(actual)).toEqual(JSON.parse(readFileSync(file, 'utf8')));
}
