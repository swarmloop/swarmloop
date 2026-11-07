import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import { duration } from '../../../lib/format';
import { CardFrame } from './card-frame';
import { httpAction } from './http-action';

type Activity = Extract<StepEvent, { kind: 'attempt.finished' | 'attempt.interrupted' | 'http.call' }>;

export function ActionCard({ event, outcome }: { event: Activity; outcome?: string }): ReactElement {
  if (event.kind === 'http.call') {
    return (
      <CardFrame
        side="left"
        label="HTTP call"
        meta={`${event.statusCode ?? 'no response'} · ${duration(event.durationMs)}`}
        detail={
          <div>
            {event.method} {event.url} → {event.statusCode ?? 'no response'} · {duration(event.durationMs)}
          </div>
        }
      >
        {httpAction(event.method, event.url)}
      </CardFrame>
    );
  }
  return (
    <CardFrame side="left" label="Attempt ended">
      {outcome ?? `${event.route}: ${event.summary}`}
    </CardFrame>
  );
}
