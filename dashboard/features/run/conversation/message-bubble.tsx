'use client';

import type { ReactElement, ReactNode } from 'react';
import Typography from '@mui/material/Typography';
import type { PlanChatEntry } from '@contract/plan-chat';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { Bubble, BubbleProvider } from '../transcript/bubble';

export const PLANNER = { kind: 'agent', name: 'Planner' } as const;

/**
 * A message of a conversation: the person's on the right as plain text, the planner's on the left as markdown. `title`
 * replaces `Message` or `Reply`, `files` are the names of the files sent with it, `children` come under its text.
 */
export function MessageBubble({
  entry,
  title,
  files = [],
  children,
}: {
  entry: PlanChatEntry;
  title?: string;
  files?: string[];
  children?: ReactNode;
}): ReactElement {
  const person = entry.role === 'person';
  const actor = person ? { kind: 'person' as const, name: entry.author ?? 'You' } : PLANNER;
  return (
    <BubbleProvider value={{ actor, time: '', grouped: false, problem: null, eventId: '' }}>
      <Bubble
        side={person ? 'right' : 'left'}
        type={person ? 'input' : 'agent'}
        title={title ?? (person ? 'Message' : 'Reply')}
        meta={entry.state === 'pending' ? 'Pending' : undefined}
      >
        {person ? (
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {entry.text}
          </Typography>
        ) : (
          <MarkdownBody text={entry.text} />
        )}
        {files.length > 0 ? (
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
            {`Files: ${files.join(', ')}`}
          </Typography>
        ) : null}
        {children}
      </Bubble>
    </BubbleProvider>
  );
}
