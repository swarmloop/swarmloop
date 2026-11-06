import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import Link from '@mui/material/Link';
import { CardFrame } from './card-frame';
import { problemId } from './problem-card';
import type { IssueLinks } from './transcript-model';

export function InputCard({
  event,
  issues,
}: {
  event: Extract<StepEvent, { kind: 'input.received' | 'handoff.received' }>;
  issues: IssueLinks;
}): ReactElement {
  switch (event.kind) {
    case 'input.received':
      return (
        <CardFrame side="right" label="Input">
          {event.name} · {event.inputKind} · document {event.documentId}
          {event.summary ? ` · ${event.summary}` : ''}
        </CardFrame>
      );
    case 'handoff.received':
      return (
        <CardFrame side="right" label="Input from pipeline / review">
          handoff {event.handoffId}
          {event.issueIds.map((id) => {
            const link = issues.get(id);
            return (
              <div key={id}>
                {link ? <Link href={`#${problemId(link.eventId)}`}>{id}</Link> : id}
                {link?.resolved ? ' · resolved' : ''}
              </div>
            );
          })}
        </CardFrame>
      );
  }
}
