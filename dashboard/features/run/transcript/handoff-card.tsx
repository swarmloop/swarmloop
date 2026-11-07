import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import { CardFrame } from './card-frame';
import type { IssueLinks } from './transcript-model';

type Handoff = Extract<StepEvent, { kind: 'handoff.sent' }>;

/** What a handoff carries: the summary of each document, then the title of each issue. */
function carried(event: Handoff, issues: IssueLinks): string[] {
  const titles = event.issueIds.map((id) => issues.get(id)?.title ?? 'an issue');
  return [...(event.summaries ?? []), ...titles];
}

export function HandoffCard({ event, issues }: { event: Handoff; issues: IssueLinks }): ReactElement {
  const lines = carried(event, issues);
  return (
    <CardFrame side="left" label="Handoff" meta={`handoff ${event.handoffId}`}>
      <div>{event.targetStep ? `Passed to ${event.targetStep}` : 'Passed on'}</div>
      {lines.map((line, index) => (
        <div key={`${index}-${line}`}>{line}</div>
      ))}
    </CardFrame>
  );
}
