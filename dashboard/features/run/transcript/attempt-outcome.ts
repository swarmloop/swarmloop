import { withoutTimestamp } from '@contract/event-text';
import type { StepEvent } from '@contract/step-events';

export type AttemptEnd = Extract<StepEvent, { kind: 'attempt.finished' | 'attempt.interrupted' }>;

/** The first line of a result, as a sentence about what the attempt came to. */
function outcomeWords(finish: AttemptEnd, target: string | null, issues: number): string {
  const line = withoutTimestamp(finish.summary).split('\n')[0]?.trim() ?? '';
  if (finish.kind === 'attempt.interrupted') {
    return `Stopped: ${line}`;
  }
  switch (finish.route) {
    case 'ok':
      return target ? `Done, next: ${target}` : 'Done';
    case 'waiting': {
      const questions = /(\d+) questions?/.exec(finish.summary)?.[1];
      return questions ? `Waiting for answers: ${questions} questions` : `Waiting: ${line}`;
    }
    case 'blocked':
      return `Blocked: ${line}`;
    case 'failed':
      return `Failed: ${line}`;
    default:
      return issues > 0 ? `Returned to ${finish.route}: ${issues} issues` : `Moved to ${finish.route}`;
  }
}

/** What the attempt did, besides how it ended: the lines its step added, such as the checks result. */
function outcomeFacts(finish: AttemptEnd): string[] {
  return finish.kind === 'attempt.finished' ? (finish.facts?.details ?? []) : [];
}

/** How an attempt ended as one line, from its own events. */
export function attemptOutcome(own: StepEvent[], finish: AttemptEnd): string {
  const sent = own.find((event) => event.kind === 'handoff.sent');
  const target = sent?.kind === 'handoff.sent' ? sent.targetStep : null;
  const issues = own.filter((event) => event.kind === 'issue.opened').length;
  return [outcomeWords(finish, target, issues), ...outcomeFacts(finish)].join(' · ');
}

export function whyOf(own: StepEvent[], number: number): string {
  const received = own.find((event) => event.kind === 'handoff.received');
  if (received?.kind === 'handoff.received' && received.from) {
    return `return from ${received.from}`;
  }
  if (own.some((event) => event.kind === 'session.changed' && event.reason === 'replay')) {
    return 'replay';
  }
  if (own.some((event) => event.kind === 'agent.launched' && event.resumed)) {
    return 'resumed';
  }
  return number === 1 ? 'first run' : 'run again';
}
