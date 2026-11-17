'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { CliLoginView } from '@contract/people';
import { approveCliLogin, getCliLogin } from '../../lib/endpoints';

const reason = (cause: unknown, fallback: string): string => (cause instanceof Error ? cause.message : fallback);

/** The page a person opens from `sloop login`: it shows the code and lets them approve the CLI. */
export function CliLoginPage(): ReactElement {
  const [code, setCode] = useState<string | null>(null);
  const [login, setLogin] = useState<CliLoginView | null>(null);
  const [approved, setApproved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const given = new URLSearchParams(window.location.search).get('code');
    if (!given) {
      setError('This page needs the code from sloop login.');
      return;
    }
    setCode(given);
    getCliLogin(given).then(setLogin, (cause: unknown) => setError(reason(cause, 'the login could not be read')));
  }, []);

  async function approve(): Promise<void> {
    if (code === null) {
      return;
    }
    try {
      await approveCliLogin(code);
      setApproved(true);
    } catch (cause: unknown) {
      setError(reason(cause, 'the CLI could not be approved'));
    }
  }

  return (
    <Paper sx={{ p: 4, maxWidth: 480, mx: 'auto', mt: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Typography variant="h5" component="h1">
        Sign in the CLI
      </Typography>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {login && !approved ? (
        <>
          <Typography variant="h4" component="p" sx={{ fontFamily: 'monospace' }}>
            {code}
          </Typography>
          <Typography>Allow the CLI on {login.machine} to act as you?</Typography>
          <Button variant="contained" onClick={() => void approve()}>
            Approve
          </Button>
        </>
      ) : null}
      {approved ? <Typography>The CLI is signed in. You can close this page.</Typography> : null}
    </Paper>
  );
}
