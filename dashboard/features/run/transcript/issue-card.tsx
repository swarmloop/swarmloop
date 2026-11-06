import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import { CardFrame } from './card-frame';

/** An issue this step sent back, or the pass that resolved it. The problem card of the issue stays as it was. */
export function IssueCard({
  event,
}: {
  event: Extract<StepEvent, { kind: 'issue.opened' | 'issue.resolved' }>;
}): ReactElement {
  if (event.kind === 'issue.opened') {
    return (
      <CardFrame side="left" label="Issue">
        {event.source} · {event.title}
      </CardFrame>
    );
  }
  return (
    <CardFrame side="left" label="Issue resolved">
      {event.issueId} · {event.evidence}
    </CardFrame>
  );
}
