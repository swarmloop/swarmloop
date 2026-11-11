import type { CheckCommandView, StepView } from '@contract/api';

type Visit = StepView['visits'][number];

/** The commands of the visit the window shows. A visit with no attempt id has none. */
export function visitCommands(commands: CheckCommandView[] | undefined, visit: Visit | undefined): CheckCommandView[] {
  if (!commands || !visit?.attemptId) {
    return [];
  }
  return commands.filter((command) => command.attempt === visit.attemptId);
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
      slowest = { command: command.command, ms };
    }
  }
  return {
    passed: commands.filter((command) => command.status === 'passed' || command.status === 'skipped').length,
    total: commands.length,
    slowest,
  };
}
