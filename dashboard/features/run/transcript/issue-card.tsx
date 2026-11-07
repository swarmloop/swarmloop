import type { ReactElement } from 'react';
import type { StepEvent } from '@contract/step-events';
import Link from '@mui/material/Link';
import { Bubble } from './bubble';
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
      <Bubble side="left" title="Issue" type="warning" meta={`from ${event.source} · ${state}`}>
        <div>{event.title}</div>
        {event.line ? <div>{event.line}</div> : null}
        {event.returnedTo ? <div>returned to {event.returnedTo}</div> : null}
      </Bubble>
    );
  }
  const link = issues.get(event.issueId);
  return (
    <Bubble side="left" title="Issue resolved" type="success">
      Resolved in attempt {attempt}: {evidenceWords(event.evidence)}
      {link ? (
        <>
          {' · '}
          <Link href={`#${problemId(link.eventId)}`}>{link.title}</Link>
        </>
      ) : null}
    </Bubble>
  );
}
