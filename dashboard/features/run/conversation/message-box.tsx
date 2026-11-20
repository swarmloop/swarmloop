'use client';

import { type ReactElement, useState } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { FlowView } from '@contract/api';
import type { ComposerMode } from '@contract/plan-chat';
import { Composer } from '../../../components/composer/composer';
import { sendPlanChat } from '../../../lib/endpoints';
import { NewRunDialog } from '../../new-run';
import { composerHint } from './composer-hint';

/** The line a follow-up run starts with: what run it follows and where to read it. */
function followUpLine(runKey: string): string {
  return `Follow-up of run ${runKey}: ${window.location.origin}/runs/${encodeURIComponent(runKey)}`;
}

/**
 * The message box of the conversation: it sends to the run's planner, or, on a merged, closed or removed run, starts a
 * follow-up run with the message and a link to this run.
 */
export function MessageBox({
  flow,
  mode,
  onChange,
}: {
  flow: FlowView;
  mode: ComposerMode;
  onChange: (flow: FlowView) => void;
}): ReactElement {
  const [text, setText] = useState('');
  const [sent, setSent] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [followUp, setFollowUp] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  const followingUp = mode === 'follow-up';

  const clear = (): void => {
    setText('');
    setSent((count) => count + 1);
  };

  const send = (message: string, files: { id: string }[]): void => {
    if (followingUp) {
      setFollowUp(`${message.trim()}\n\n${followUpLine(flow.key)}`);
      return;
    }
    setBusy(true);
    setError(null);
    sendPlanChat(
      flow.key,
      message,
      files.map((file) => file.id),
    )
      .then((next) => {
        clear();
        onChange(next);
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
        hint={composerHint(mode)}
        onSend={send}
        label="Message to the planner"
        sendLabel={followingUp ? 'Start a follow-up run' : 'Send'}
        disabled={busy}
        minRows={2}
      />
      {error ? (
        <Typography color="error" variant="body2" role="alert">
          {error}
        </Typography>
      ) : null}
      {started ? (
        <Typography variant="body2">
          <Link href={`/runs/${encodeURIComponent(started)}` as Route}>{`Open the follow-up run ${started}`}</Link>
        </Typography>
      ) : null}
      {followUp !== null ? (
        <NewRunDialog
          key={followUp}
          open
          title="Follow-up run"
          initialPrompt={followUp}
          onClose={() => setFollowUp(null)}
          onCreated={(key) => {
            setFollowUp(null);
            setStarted(key);
            clear();
          }}
        />
      ) : null}
    </Box>
  );
}
