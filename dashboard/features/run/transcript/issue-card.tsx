import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import Link from '@mui/material/Link';
import { CardFrame } from './card-frame';
import { problemId } from './problem-card';
import type { IssueLinks } from './transcript-model';

/** What the pass that resolved an issue showed, in words: `pipeline a-2` is the pass of the step `pipeline`. */
function evidenceWords(evidence: string): string {
  const step = /^[\w-]+/.exec(evidence)?.[0];
  return step ? `${step} passed` : evidence;
}

/** An issue this step sent back, or the pass that resolved it. The problem card of the issue stays as it was. */
export function IssueCard({
  event,
  issues,
  attempt,
}: {
  event: Extract<StepEvent, { kind: 'issue.opened' | 'issue.resolved' }>;
  issues: IssueLinks;
  attempt: number;
}): ReactElement {
  if (event.kind === 'issue.opened') {
    const state = issues.get(event.issueId)?.resolved ? 'resolved' : 'open';
    return (
      <CardFrame side="left" label="Issue" meta={`from ${event.source} · ${state}`}>
        <div>{event.title}</div>
        {event.line ? <div>{event.line}</div> : null}
        {event.returnedTo ? <div>returned to {event.returnedTo}</div> : null}
      </CardFrame>
    );
  }
  const link = issues.get(event.issueId);
  return (
    <CardFrame side="left" label="Issue resolved">
      Resolved in attempt {attempt}: {evidenceWords(event.evidence)}
      {link ? (
        <>
          {' · '}
          <Link href={`#${problemId(link.eventId)}`}>{link.title}</Link>
        </>
      ) : null}
    </CardFrame>
  );
}
