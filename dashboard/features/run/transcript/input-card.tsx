import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import Link from '@mui/material/Link';
import { Bubble } from './bubble';
import { DocumentDetail } from './document-detail';
import { problemId } from './problem-card';
import type { IssueLinks } from './transcript-model';

/** What the card says about an input: the summary, or that the step found nothing. */
function inputText(event: Extract<StepEvent, { kind: 'input.received' }>): string {
  return event.summary === 'absent' ? `${event.name} is not available` : event.summary;
}

export function InputCard({
  runKey,
  event,
  issues,
}: {
  runKey: string;
  event: Extract<StepEvent, { kind: 'input.received' | 'handoff.received' }>;
  issues: IssueLinks;
}): ReactElement {
  switch (event.kind) {
    case 'input.received':
      return (
        <Bubble
          side="right"
          type="input"
          title={event.name}
          meta={event.documentId === 'absent' ? undefined : `document ${event.documentId}`}
          detail={event.documentId === 'absent' ? undefined : <DocumentDetail runKey={runKey} kind={event.inputKind} />}
          detailLabel="document"
        >
          <div>{inputText(event)}</div>
          {event.meta ? <div>{event.meta}</div> : null}
        </Bubble>
      );
    case 'handoff.received':
      return (
        <Bubble
          side="right"
          type="input"
          title={`Input from ${event.from ?? 'pipeline / review'}`}
          meta={`handoff ${event.handoffId}`}
          detail={<DocumentDetail runKey={runKey} kind="return" />}
          detailLabel="return notes"
        >
          <div>
            From {event.from ?? 'pipeline / review'}: {event.issueIds.length} issues
          </div>
          {event.issueIds.map((id) => {
            const link = issues.get(id);
            return (
              <div key={id}>
                {link ? (
                  <Link href={`#${problemId(link.eventId)}`}>{link.title}</Link>
                ) : (
                  'an issue returned to this step'
                )}
                {link?.line ? ` · ${link.line}` : ''}
                {link?.resolved ? ' · resolved' : ''}
              </div>
            );
          })}
        </Bubble>
      );
  }
}
