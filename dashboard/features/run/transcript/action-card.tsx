import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import { duration } from '../../../lib/format';
import { limitSentence } from '../../../lib/runtime-limit';
import { loopSentence } from '../../../lib/loop-sentence';
import { Bubble } from './bubble';
import { CheckList } from './check-list';
import { httpAction } from './http-action';

type Activity = Extract<
  StepEvent,
  {
    kind:
      | 'attempt.finished'
      | 'attempt.interrupted'
      | 'http.call'
      | 'agent.limited'
      | 'agent.effort_capped'
      | 'agent.loop_hint';
  }
>;

/** A cut by a server restart is not a warning: the server starts the step again. */
function attemptType(
  event: Extract<Activity, { kind: 'attempt.finished' | 'attempt.interrupted' }>,
): 'warning' | 'success' | 'activity' {
  if (event.kind === 'attempt.interrupted') {
    return event.route === 'process died' ? 'activity' : 'warning';
  }
  return event.route === 'ok' ? 'success' : 'activity';
}

export function ActionCard({ event, outcome }: { event: Activity; outcome?: string }): ReactElement {
  if (event.kind === 'http.call') {
    return (
      <Bubble
        side="left"
        title="HTTP call"
        meta={`${event.statusCode ?? 'no response'} · ${duration(event.durationMs)}`}
        detail={
          <div>
            {event.method} {event.url} → {event.statusCode ?? 'no response'} · {duration(event.durationMs)}
          </div>
        }
      >
        {httpAction(event.method, event.url)}
      </Bubble>
    );
  }
  if (event.kind === 'agent.limited') {
    return (
      <Bubble side="left" title="Usage limit" type="warning">
        {limitSentence(event)}
      </Bubble>
    );
  }
  if (event.kind === 'agent.effort_capped') {
    return (
      <Bubble side="left" title="Effort lowered" type="activity">
        {event.text}
      </Bubble>
    );
  }
  if (event.kind === 'agent.loop_hint') {
    return (
      <Bubble side="left" title={event.ended ? 'Agent looping' : 'Repeated command'} type="warning">
        {loopSentence(event)}
      </Bubble>
    );
  }
  return (
    <Bubble side="left" title="Attempt ended" type={attemptType(event)}>
      {outcome ?? `${event.route}: ${event.summary}`}
      {event.kind === 'attempt.finished' && event.facts?.checks ? <CheckList checks={event.facts.checks} /> : null}
    </Bubble>
  );
}
