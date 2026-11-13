import type { StepEvent } from '@contract/step-events';
import { limitSentence } from '../../../lib/runtime-limit';
import { loopSentence } from '../../../lib/loop-sentence';

type CommandEnd = Extract<StepEvent, { kind: 'command.finished' }>;

/** Why an event is an error, and the action it belongs to. */
export interface Problem {
  cause: string;
  action: string;
}

/** A command as a person reads it: `-C <path>` shows the repo name. The event keeps the full args. */
export function commandLine(event: Extract<StepEvent, { kind: 'command.started' }>): string {
  const args =
    event.args[0] === '-C' && event.args.length > 1 ? ['-C', event.repo, ...event.args.slice(2)] : event.args;
  return [event.executable, ...args].join(' ');
}

/** A command is a problem when it timed out, was cancelled, or a server call failed and the exit was not its answer. */
function commandProblem(
  event: Extract<StepEvent, { kind: 'command.started' }>,
  end: CommandEnd | null,
): Problem | null {
  const action = `command: ${commandLine(event)}`;
  if (end?.timedOut) {
    return { cause: 'timed out', action };
  }
  if (end?.cancelled) {
    return { cause: 'cancelled', action };
  }
  // An agent's own command that exits non-zero is its normal work, and a server call may declare an exit as its answer.
  const failed = event.actor === 'server' && end && !end.answer && end.exitCode !== null && end.exitCode !== 0;
  return failed ? { cause: `exit code ${end.exitCode}`, action } : null;
}

export function problemOf(event: StepEvent, end: CommandEnd | null): Problem | null {
  if (event.kind === 'command.started') {
    return commandProblem(event, end);
  }
  if (event.kind === 'agent.finished') {
    return event.killReason ? { cause: `killed: ${event.killReason}`, action: `agent: ${event.model}` } : null;
  }
  if (event.kind === 'agent.limited') {
    return { cause: limitSentence(event), action: `agent: ${event.runtime}` };
  }
  if (event.kind === 'agent.loop_hint') {
    return event.ended ? { cause: loopSentence(event), action: 'agent: looping' } : null;
  }
  if (event.kind === 'http.call') {
    const action = `${event.method} ${event.url}`;
    if (event.statusCode === null) {
      return { cause: 'no response', action };
    }
    return event.statusCode >= 400 ? { cause: `status ${event.statusCode}`, action } : null;
  }
  if (event.kind === 'issue.opened') {
    return { cause: event.title, action: `issue ${event.issueId}` };
  }
  return event.kind === 'attempt.interrupted' ? { cause: event.summary, action: 'attempt' } : null;
}
