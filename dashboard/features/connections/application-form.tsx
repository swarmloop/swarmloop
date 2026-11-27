'use client';

import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import TextField from '@mui/material/TextField';
import type { ApplicationSetupView } from '@contract/host-login';
import { ApiError } from '../../lib/api';
import { saveApplication } from '../../lib/endpoints';
import { ConfirmDialog } from '../shell';
import type { HostTexts } from './logos';

const NAMED_MAX = 5;

/** Who a replace disconnects: by name when there are few, else the count. */
export function disconnected(people: string[]): string {
  if (people.length === 0) {
    return 'Everyone connected through this app';
  }
  return people.length <= NAMED_MAX ? people.join(', ') : `${people.length} people`;
}

type Replacing = { name: string; connected: string[] };

/** The steps to register an application on the host, and the two fields that hand it to swarmloop. */
export function ApplicationForm({
  setup,
  label,
  texts,
  replacing,
  onSaved,
}: {
  setup: ApplicationSetupView;
  label: string;
  texts: NonNullable<HostTexts['application']>;
  replacing?: Replacing;
  onSaved: () => void;
}): ReactElement {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);

  /** Posts the two fields. A 422 marks both fields and resolves; any other error is thrown. */
  async function post(): Promise<void> {
    setFieldError(null);
    try {
      await saveApplication(setup.provider, clientId.trim(), clientSecret.trim());
    } catch (cause: unknown) {
      if (cause instanceof ApiError && cause.status === 422) {
        setFieldError(cause.message);
        return;
      }
      throw cause;
    }
    onSaved();
  }

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    if (replacing) {
      setAsking(true);
      return;
    }
    setBusy(true);
    try {
      await post();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'the application was not saved');
    }
    setBusy(false);
  }

  return (
    <Box
      component="form"
      aria-label={`${label} application`}
      onSubmit={(event) => void submit(event)}
      sx={{ display: 'flex', flexDirection: 'column', gap: 1.5 }}
    >
      <Box component="ol" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
        <li>
          <Link href={setup.page} target="_blank" rel="noopener noreferrer">
            Open Applications on {new URL(setup.page).host}
          </Link>{' '}
          and add a new application.
        </li>
        <li>
          Use this callback:
          <Box sx={{ display: 'flex', gap: 1, mt: 0.5 }}>
            <TextField
              size="small"
              fullWidth
              value={setup.callback}
              slotProps={{ htmlInput: { readOnly: true, 'aria-label': 'Callback URL' } }}
            />
            <Button variant="outlined" onClick={() => void navigator.clipboard.writeText(setup.callback)}>
              Copy
            </Button>
          </Box>
        </li>
        <li>Tick the scopes: {setup.scopes.join(', ')}.</li>
        <li>{texts.confidential}</li>
        <li>
          Paste the two values it shows:
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, mt: 0.5 }}>
            <TextField
              label={texts.idLabel}
              size="small"
              required
              value={clientId}
              error={fieldError !== null}
              onChange={(event) => setClientId(event.target.value)}
            />
            <TextField
              label={texts.secretLabel}
              size="small"
              type="password"
              required
              autoComplete="off"
              value={clientSecret}
              error={fieldError !== null}
              helperText={fieldError}
              onChange={(event) => setClientSecret(event.target.value)}
            />
          </Box>
        </li>
      </Box>
      {error ? <Alert severity="error">{error}</Alert> : null}
      <Button type="submit" variant="contained" disabled={busy}>
        {replacing ? 'Replace application' : `Connect ${label}`}
      </Button>
      {replacing ? (
        <ConfirmDialog
          open={asking}
          title={`Replace ${replacing.name}?`}
          body={`${disconnected(replacing.connected)} will be disconnected. Their runs wait with GIT_AUTH until they log in again.`}
          verb="Replace application"
          tone="danger"
          onConfirm={post}
          onClose={() => setAsking(false)}
        />
      ) : null}
    </Box>
  );
}
