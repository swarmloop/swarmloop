'use client';

import { type ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BacklogChatView } from '@contract/backlog-chat';
import { Composer } from '../../../components/composer/composer';
import { sendBacklogMessage } from '../../../lib/backlog-endpoints';

/** The message box of a backlog's planner. Only the owner writes; anyone else is told who does. */
export function BacklogMessageBox({
  name,
  owner,
  isOwner,
  onChat,
}: {
  name: string;
  owner: string;
  isOwner: boolean;
  onChat: (chat: BacklogChatView) => void;
}): ReactElement {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!isOwner) {
    return (
      <Typography variant="body2" color="text.secondary">
        {`Only ${owner} writes to this planner.`}
      </Typography>
    );
  }
  const send = (message: string, files: { id: string }[]): void => {
    setBusy(true);
    setError(null);
    sendBacklogMessage(
      name,
      message,
      files.map((file) => file.id),
      crypto.randomUUID(),
    )
      .then((next) => {
        setText('');
        setSent((count) => count + 1);
        onChat(next);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'The message was not sent'))
      .finally(() => setBusy(false));
  };
  return (
    <Box sx={{ display: 'grid', gap: 1 }}>
      <Composer
        key={sent}
        value={text}
        onChange={setText}
        onSend={send}
        label="Message to the planner"
        sendLabel="Send"
        disabled={busy}
        minRows={2}
      />
      {error ? (
        <Typography color="error" variant="body2" role="alert">
          {error}
        </Typography>
      ) : null}
    </Box>
  );
}
