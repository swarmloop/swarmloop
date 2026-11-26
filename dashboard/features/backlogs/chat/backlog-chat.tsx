'use client';

import { type ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import type { BacklogChatView } from '@contract/backlog-chat';
import { resumeBacklogTurn } from '../../../lib/backlog-endpoints';
import { FeedLog, InfoLine, MessageBubble, ProblemCard } from '../../run';
import { BacklogMessageBox } from './backlog-message-box';
import { type ChatRow, chatRows } from './chat-rows';
import { stateWord, toEntry } from './message-entry';
import { ProposalEntry } from './proposal-entry';
import { ThinkingRow } from './thinking-row';

interface BacklogChatProps {
  view: BacklogView;
  chat: BacklogChatView;
  login: string | null;
  onView: (view: BacklogView) => void;
  onChat: (chat: BacklogChatView) => void;
}

/** The chat with a backlog's planner: the conversation of the run, its message box at the bottom. */
export function BacklogChat({ view, chat, login, onView, onChat }: BacklogChatProps): ReactElement {
  const [error, setError] = useState<string | null>(null);
  const owner = login !== null && login === view.owner;
  const rows = chatRows(chat, view, login);
  const resume = (): void => {
    setError(null);
    resumeBacklogTurn(view.name)
      .then(onChat)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The turn was not resumed'));
  };
  const draw = (row: ChatRow): ReactElement | null => {
    switch (row.type) {
      case 'older':
      case 'info':
        return <InfoLine key={row.key} sentence={row.sentence} />;
      case 'message':
        return (
          <MessageBubble
            key={row.key}
            entry={toEntry(row.message)}
            files={(row.message.attachments ?? []).map((file) => file.name)}
            meta={stateWord(row.message)}
          />
        );
      case 'proposal':
        return (
          <ProposalEntry
            key={row.key}
            view={view}
            message={row.message}
            number={row.milestone.number}
            first={row.first}
            owner={owner}
            onView={onView}
          />
        );
      case 'problem':
        return (
          <ProblemCard
            key={row.key}
            sentence={row.sentence}
            reason={row.reason}
            resume={row.resume ? { label: 'Resume', disabled: false, onClick: resume } : undefined}
          />
        );
      case 'working':
        return <ThinkingRow key={row.key} startedAt={row.startedAt} />;
    }
  };
  return (
    <Box
      component="section"
      aria-label="Chat"
      sx={{ height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}
    >
      <FeedLog count={rows.length}>{rows.map(draw)}</FeedLog>
      {error ? (
        <Typography color="error" variant="body2" role="alert">
          {error}
        </Typography>
      ) : null}
      <BacklogMessageBox name={view.name} owner={view.owner} isOwner={owner} onChat={onChat} />
    </Box>
  );
}
