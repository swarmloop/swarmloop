import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import { duration } from '../../../lib/format';
import { limitSentence } from '../../../lib/runtime-limit';
import { Bubble } from './bubble';
import { httpAction } from './http-action';

type Activity = Extract<
  StepEvent,
  { kind: 'attempt.finished' | 'attempt.interrupted' | 'http.call' | 'host.suspended' | 'agent.limited' }
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
    </Bubble>
  );
}
