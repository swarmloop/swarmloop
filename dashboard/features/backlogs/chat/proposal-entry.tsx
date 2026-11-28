'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import type { BacklogMessageView } from '@contract/backlog-chat';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { isLong, MessageBubble } from '../../run';
import type { LiveOffer } from './chat-rows';
import { toEntry } from './message-entry';
import { StartButtons } from './start-buttons';

function proposalText(view: BacklogView, number: number): string {
  const milestone = view.milestones.find((item) => item.number === number);
  const requirements = view.requirements.filter((item) => item.milestone === number);
  const tasks = view.tasks.filter((item) => item.milestone === number);
  return [
    `**M${number} · ${milestone?.title ?? ''}**`,
    milestone?.goal ?? '',
    '**Requirements**',
    requirements.map((item) => `- ${item.text}`).join('\n'),
    '**Tasks**',
    tasks.map((item) => `- ${item.title}`).join('\n'),
  ]
    .filter((part) => part !== '')
    .join('\n\n');
}

function Folded({ text }: { text: string }): ReactElement {
  if (!isLong(text)) {
    return <MarkdownBody text={text} />;
  }
  return (
    <Box component="details">
      <Box component="summary" sx={{ cursor: 'pointer', fontSize: 14 }}>
        Show the whole milestone
      </Box>
      <MarkdownBody text={text} />
    </Box>
  );
}

/**
 * The planner's offer to run a milestone: its goal, requirements and tasks, the question whether to run it and, for the
 * owner, one click to run it, or, for the first proposed one, to run it and the proposed ones after it.
 */
export function ProposalEntry({
  view,
  message,
  number,
  offers,
  owner,
  onView,
}: {
  view: BacklogView;
  message: BacklogMessageView;
  number: number;
  offers: LiveOffer[];
  owner: boolean;
  onView: (view: BacklogView) => void;
}): ReactElement {
  return (
    <MessageBubble entry={toEntry(message)} title="Question for you">
      <Folded text={proposalText(view, number)} />
      <Typography variant="body2" sx={{ mt: 1 }}>
        Do you want to run this milestone?
      </Typography>
      {owner && offers.length > 0 ? <StartButtons view={view} offers={offers} onView={onView} /> : null}
    </MessageBubble>
  );
}
