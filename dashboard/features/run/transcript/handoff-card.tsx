import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import { CardFrame } from './card-frame';

type Handoff = Extract<StepEvent, { kind: 'handoff.sent' }>;

/** What a handoff carries, as one line. */
export function handoffText(event: Handoff): string {
  const parts = [
    `handoff ${event.handoffId}`,
    event.artifactKinds.length > 0 ? `artifacts: ${event.artifactKinds.join(', ')}` : '',
    event.issueIds.length > 0 ? `issues: ${event.issueIds.join(', ')}` : '',
  ];
  return parts.filter(Boolean).join(' · ');
}

export function HandoffCard({ event }: { event: Handoff }): ReactElement {
  return (
    <CardFrame side="left" label={`Handoff to ${event.targetStep ?? 'no step'}`}>
      {handoffText(event)}
    </CardFrame>
  );
}
