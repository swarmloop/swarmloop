import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import { CardFrame } from './card-frame';
import { handoffText } from './handoff-card';

export function InputCard({
  event,
}: {
  event: Extract<StepEvent, { kind: 'input.received' | 'handoff.sent' | 'issue.opened' }>;
}): ReactElement {
  switch (event.kind) {
    case 'input.received':
      return (
        <CardFrame side="right" label="Input">
          {event.name} · {event.inputKind} · document {event.documentId}
          {event.summary ? ` · ${event.summary}` : ''}
        </CardFrame>
      );
    case 'handoff.sent':
      return (
        <CardFrame side="right" label="Handoff received">
          {handoffText(event)}
        </CardFrame>
      );
    case 'issue.opened':
      return (
        <CardFrame side="right" label="Issue">
          {event.source} · {event.title}
        </CardFrame>
      );
  }
}
