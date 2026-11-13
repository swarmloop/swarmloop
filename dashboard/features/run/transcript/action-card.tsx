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
      | 'host.suspended'
      | 'agent.limited'
      | 'agent.effort_capped'
      | 'agent.loop_hint';
  }
>;

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
  if (event.kind === 'host.suspended') {
    return (
      <Bubble side="left" title="Host suspended" type="activity">
        {duration(event.durationMs)}, not counted
      </Bubble>
    );
  }
  return (
    <Bubble
      side="left"
      title="Attempt ended"
      type={event.kind === 'attempt.interrupted' ? 'warning' : event.route === 'ok' ? 'success' : 'activity'}
    >
      {outcome ?? `${event.route}: ${event.summary}`}
      {event.kind === 'attempt.finished' && event.facts?.checks ? <CheckList checks={event.facts.checks} /> : null}
    </Bubble>
  );
}
