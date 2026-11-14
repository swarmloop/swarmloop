'use client';

import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import { sendSignInCode } from '../../../lib/endpoints';
import { messageOf, type FlowDialogProps } from './flow-types';
import { SignInDialog } from './sign-in-dialog';
import { useSignIn } from './use-sign-in';

/** A CLI sign-in: it shows a link, then asks for the code the provider's page gives. */
export function CliCodeFlow(props: FlowDialogProps): ReactElement {
  const { view, error, setView } = useSignIn(props.card.id);
  const [code, setCode] = useState('');
  const [sendError, setSendError] = useState<string | null>(null);

  async function send(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!view) {
      return;
    }
    setSendError(null);
    try {
      setView(await sendSignInCode(props.card.id, view.id, code));
    } catch (cause: unknown) {
      setSendError(messageOf(cause, 'the code could not be sent'));
    }
  }

  return (
    <SignInDialog {...props} view={view} error={error}>
      {view?.state === 'code' ? (
        <Box component="form" onSubmit={(event) => void send(event)} sx={{ display: 'flex', gap: 1 }}>
          <TextField
            label="Code"
            size="small"
            autoComplete="off"
            value={code}
            onChange={(event) => setCode(event.target.value)}
            sx={{ flexGrow: 1 }}
          />
          <Button type="submit" variant="contained" disabled={code.trim() === ''}>
            Send code
          </Button>
        </Box>
      ) : null}
      {sendError ? <Alert severity="error">{sendError}</Alert> : null}
    </SignInDialog>
  );
}
