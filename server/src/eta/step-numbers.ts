import type { RunKind } from '../contract/eta';
import type { EtaTable, FinishedRunInput, KindNumbers } from './eta.types';
import { runKind, workingMs } from './working-time';

const SAMPLE_RUNS = 50;

const KINDS: readonly RunKind[] = ['plain', 'epic', 'subtask'];

interface Ended {
  run: FinishedRunInput;
  end: string;
}

function median(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function endOf(run: FinishedRunInput, kind: RunKind): string | null {
  return kind === 'subtask' ? run.mergedAt : run.lastFinishedAt;
}

function firstEntries(run: FinishedRunInput): Map<string, string> {
  const first = new Map<string, string>();
  for (const { step, startedAt } of run.entries) {
    const known = first.get(step);
    if (known === undefined || Date.parse(startedAt) < Date.parse(known)) {
      first.set(step, startedAt);
    }
  }
  return first;
}

/** The median working time of one visit of each step, from the visits of the newest runs that entered it. */
function visitNumbers(newestFirst: readonly Ended[]): Record<string, number> {
  const samples = new Map<string, number[]>();
  const taken = new Map<string, number>();
  for (const { run } of newestFirst) {
    for (const step of new Set(run.entries.map((entry) => entry.step))) {
      const count = taken.get(step) ?? 0;
      if (count >= SAMPLE_RUNS) continue;
      taken.set(step, count + 1);
      const times = run.entries
        .filter((entry) => entry.step === step)
        .map((entry) => workingMs(entry.startedAt, entry.finishedAt, run.waits));
      samples.set(step, [...(samples.get(step) ?? []), ...times]);
    }
  }
  return Object.fromEntries([...samples].map(([step, times]) => [step, median(times) ?? 0]));
}

function numbersFor(runs: Ended[]): KindNumbers {
  const newestFirst = [...runs].sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
  const samples = new Map<string, number[]>();
  const taken = new Map<string, number>();
  for (const { run, end } of newestFirst) {
    for (const [step, startedAt] of firstEntries(run)) {
      const count = taken.get(step) ?? 0;
      if (count < SAMPLE_RUNS) {
        taken.set(step, count + 1);
        samples.set(step, [...(samples.get(step) ?? []), workingMs(startedAt, end, run.waits)]);
      }
    }
  }
  const steps: Record<string, number> = {};
  for (const [step, values] of samples) {
    steps[step] = median(values) ?? 0;
  }
  const whole = median(
    newestFirst.slice(0, SAMPLE_RUNS).map(({ run, end }) => workingMs(run.createdAt, end, run.waits)),
  );
  return { steps, visits: visitNumbers(newestFirst), whole };
}

/** One number per step and kind of run, from the newest finished runs of that kind that entered the step. */
export function stepNumbers(runs: readonly FinishedRunInput[]): EtaTable {
  const grouped: Record<RunKind, Ended[]> = { plain: [], epic: [], subtask: [] };
  for (const run of runs) {
    const kind = runKind(run);
    const end = endOf(run, kind);
    if (end !== null) {
      grouped[kind].push({ run, end });
    }
  }
  return Object.fromEntries(KINDS.map((kind) => [kind, numbersFor(grouped[kind])])) as EtaTable;
}
