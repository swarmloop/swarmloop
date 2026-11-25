import type { CheckCommandView, StepView } from '@contract/api';

type Visit = StepView['visits'][number];

/** The commands of the visit the window shows. A visit with no attempt id has none. */
export function visitCommands(commands: CheckCommandView[] | undefined, visit: Visit | undefined): CheckCommandView[] {
  if (!commands || !visit?.attemptId) {
    return [];
  }
  return commands.filter((command) => command.attempt === visit.attemptId);
}

/** What a command is called: its short name, or its command line for a row from before names. */
export function commandLabel(command: CheckCommandView): string {
  return command.name ?? command.command;
}

/** The rows of the step view, with every row of the attempt the live rows belong to replaced by the live rows. */
export function liveCommands(
  viewRows: CheckCommandView[] | undefined,
  flowRows: CheckCommandView[] | undefined,
): CheckCommandView[] {
  const live = flowRows ?? [];
  const attempts = new Set(live.map((row) => row.attempt));
  return [...(viewRows ?? []).filter((row) => !attempts.has(row.attempt)), ...live];
}

/** Commands by state. A skipped command is counted apart from the passed ones; a stored `waiting` command is queued. */
export function commandCounts(commands: CheckCommandView[]): {
  passed: number;
  skipped: number;
  failed: number;
  running: number;
  queued: number;
  total: number;
} {
  const of = (state: CheckCommandView['status']) => commands.filter((row) => row.status === state).length;
  return {
    passed: of('passed'),
    skipped: of('skipped'),
    failed: of('failed'),
    running: of('running'),
    queued: of('waiting'),
    total: commands.length,
  };
}

/** What a checks step says while it waits for a free check slot, in place of `running`. */
export const SLOT_WAIT = 'waits for a free check slot';

/** True while no command runs and at least one waits: the step waits for a free check slot. */
export function waitsForSlot(commands: CheckCommandView[] = []): boolean {
  const { running, queued } = commandCounts(commands);
  return running === 0 && queued > 0;
}

/** The status word of a checks step: the wait for a slot in place of `running`. */
export function checksStatusWord(label: string, summary: { waitsForSlot: boolean } | undefined): string {
  return label === 'running' && summary?.waitsForSlot ? SLOT_WAIT : label;
}

/** The commands that run before the skipped ones, each group in its own order. */
export function skippedLast(commands: CheckCommandView[]): CheckCommandView[] {
  return [
    ...commands.filter((command) => command.status !== 'skipped'),
    ...commands.filter((command) => command.status === 'skipped'),
  ];
}

/** The key of a command in `skipReasons`. */
export function skipKey(command: Pick<CheckCommandView, 'repo' | 'command'>): string {
  return `${command.repo}\n${command.command}`;
}

/** Why each command was skipped, from the `checks` documents with `skipped: true`, by `skipKey`. A body that does not read is ignored. */
export function skipReasons(documents: StepView['visits'][number]['documents'] | undefined): Record<string, string> {
  const reasons: Record<string, string> = {};
  for (const document of documents ?? []) {
    if (document.kind !== 'checks') {
      continue;
    }
    try {
      const record: unknown = JSON.parse(document.body);
      if (typeof record === 'object' && record !== null && 'skipped' in record && record.skipped === true) {
        const { repo, command, tail } = record as { repo?: unknown; command?: unknown; tail?: unknown };
        if (typeof repo === 'string' && typeof command === 'string' && typeof tail === 'string') {
          reasons[skipKey({ repo, command })] = tail;
        }
      }
    } catch {
      continue;
    }
  }
  return reasons;
}

/** How long a command ran, or has been running. Null before it started. */
export function commandMs(command: CheckCommandView, now: number): number | null {
  if (!command.startedAt) {
    return null;
  }
  const end = command.endedAt ? Date.parse(command.endedAt) : now;
  return Math.max(0, end - Date.parse(command.startedAt));
}

/** `passed/total` over the commands that run: a skipped command is counted apart. */
export function commandSummary(
  commands: CheckCommandView[],
  now: number,
): {
  passed: number;
  total: number;
  skipped: number;
  waitsForSlot: boolean;
  slowest: { command: string; ms: number } | null;
} {
  let slowest: { command: string; ms: number } | null = null;
  for (const command of commands) {
    const ms = commandMs(command, now);
    if (ms !== null && (!slowest || ms > slowest.ms)) {
      slowest = { command: commandLabel(command), ms };
    }
  }
  const counts = commandCounts(commands);
  return {
    passed: counts.passed,
    total: counts.total - counts.skipped,
    skipped: counts.skipped,
    waitsForSlot: waitsForSlot(commands),
    slowest,
  };
}
