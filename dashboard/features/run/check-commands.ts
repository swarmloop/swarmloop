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

/** Commands by state. A skipped command counts as passed; a stored `waiting` command is queued. */
export function commandCounts(commands: CheckCommandView[]): {
  passed: number;
  failed: number;
  running: number;
  queued: number;
  total: number;
} {
  const of = (...states: CheckCommandView['status'][]) => commands.filter((row) => states.includes(row.status)).length;
  return {
    passed: of('passed', 'skipped'),
    failed: of('failed'),
    running: of('running'),
    queued: of('waiting'),
    total: commands.length,
  };
}

/** How long a command ran, or has been running. Null before it started. */
export function commandMs(command: CheckCommandView, now: number): number | null {
  if (!command.startedAt) {
    return null;
  }
  const end = command.endedAt ? Date.parse(command.endedAt) : now;
  return Math.max(0, end - Date.parse(command.startedAt));
}

/** `passed/total` counts a skipped command as passed: it passed on the same files. */
export function commandSummary(
  commands: CheckCommandView[],
  now: number,
): { passed: number; total: number; slowest: { command: string; ms: number } | null } {
  let slowest: { command: string; ms: number } | null = null;
  for (const command of commands) {
    const ms = commandMs(command, now);
    if (ms !== null && (!slowest || ms > slowest.ms)) {
      slowest = { command: commandLabel(command), ms };
    }
  }
  return {
    passed: commandCounts(commands).passed,
    total: commands.length,
    slowest,
  };
}
