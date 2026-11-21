'use client';

import { type ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import type { BacklogMessageView } from '@contract/backlog-chat';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { runBacklog, runMilestone } from '../../../lib/backlog-endpoints';
import { isLong, MessageBubble } from '../../run';
import { toEntry } from './message-entry';

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
  first,
  owner,
  onView,
}: {
  view: BacklogView;
  message: BacklogMessageView;
  number: number;
  first: boolean;
  owner: boolean;
  onView: (view: BacklogView) => void;
}): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = (run: () => Promise<BacklogView>): void => {
    setBusy(true);
    setError(null);
    run()
      .then(onView)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The action was refused'))
      .finally(() => setBusy(false));
  };
  return (
    <MessageBubble entry={toEntry(message)} title="Question for you">
      <Folded text={proposalText(view, number)} />
      <Typography variant="body2" sx={{ mt: 1 }}>
        Do you want to run this milestone?
      </Typography>
      {owner ? (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1, mt: 1 }}>
          <Button
            size="small"
            variant="contained"
            disabled={busy}
            onClick={() => act(() => runMilestone(view.name, number))}
          >
            Run milestone
          </Button>
          {first ? (
            <Button size="small" variant="outlined" disabled={busy} onClick={() => act(() => runBacklog(view.name))}>
              Run backlog
            </Button>
          ) : null}
        </Box>
      ) : null}
      {error ? (
        <Typography color="error" variant="body2" role="alert">
          {error}
        </Typography>
      ) : null}
    </MessageBubble>
  );
}
