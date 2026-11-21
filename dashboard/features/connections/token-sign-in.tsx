'use client';

import type { KeyboardEvent, ReactElement } from 'react';
import { useState } from 'react';
import type { TokenSignInView } from '@contract/api';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { signInWithToken } from '../../lib/endpoints';

/**
 * Signs in with a personal access token the person makes on the host. It is not a form, so it can sit inside the
 * card of the first-run screen: Enter in the field signs in and never submits the card.
 */
export function TokenSignIn({
  entry,
  label,
  next,
}: {
  entry: TokenSignInView;
  label: string;
  next: string | null;
}): ReactElement {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn(): Promise<void> {
    setError(null);
    setBusy(true);
    try {
      const { url } = await signInWithToken(entry.provider, token.trim(), next);
      window.location.assign(url);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'the token could not be used');
      setBusy(false);
    }
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!busy) {
        void signIn();
      }
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, width: '100%' }}>
      <Typography variant="body2" color="text.secondary">
        {label} at {entry.base}
      </Typography>
      <Link href={entry.tokenPage} target="_blank" rel="noreferrer" variant="body2">
        Create a token
      </Link>
      <TextField
        label="Personal access token"
        size="small"
        type="password"
        autoComplete="off"
        value={token}
        error={error !== null}
        helperText={error}
        onChange={(event) => setToken(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <Button type="button" variant="outlined" disabled={busy} onClick={() => void signIn()}>
        Sign in with token
      </Button>
    </Box>
  );
}
