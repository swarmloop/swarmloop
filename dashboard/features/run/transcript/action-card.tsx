import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import { duration } from '../../../lib/format';
import { CardFrame } from './card-frame';

type Activity = Extract<StepEvent, { kind: 'attempt.finished' | 'attempt.interrupted' | 'http.call' }>;

function text(event: Activity): string {
  if (event.kind === 'http.call') {
    return `${event.method} ${event.url} → ${event.statusCode ?? 'no response'} · ${duration(event.durationMs)}`;
  }
  return `${event.route}: ${event.summary}`;
}

export function ActionCard({ event }: { event: Activity }): ReactElement {
  return (
    <CardFrame side="left" label={event.kind === 'http.call' ? 'HTTP call' : 'Attempt ended'}>
      {text(event)}
    </CardFrame>
  );
}
