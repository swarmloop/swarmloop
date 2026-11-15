'use client';

import type { FormEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { getManifest, getOwner, saveGitlabApplication } from '../../lib/endpoints';
import { HOST_TEXTS } from './logos';

export interface ManifestForm {
  action: string;
  manifest: Record<string, unknown>;
}

/** The host takes the manifest as a form post, so the page builds the form and sends it. */
export function ManifestPost({ form }: { form: ManifestForm }): ReactElement {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => ref.current?.submit(), []);
  return (
    <form ref={ref} method="post" action={form.action}>
      <input type="hidden" name="manifest" value={JSON.stringify(form.manifest)} />
    </form>
  );
}

/** The first screen of a server with no login yet: make the host app, or hand over the host application. */
export function FirstRun(): ReactElement {
  const [org, setOrg] = useState('');
  const [others, setOthers] = useState<string[]>([]);
  const typed = useRef(false);
  const [form, setForm] = useState<ManifestForm | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Without an owner the person types one.
    getOwner().then(
      (view) => {
        if (!typed.current) {
          setOrg(view.owner);
        }
        setOthers(view.others);
      },
      () => undefined,
    );
  }, []);

  async function createApp(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      setForm(await getManifest(org.trim()));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'the app could not be prepared');
    }
  }

  async function saveApplication(event: FormEvent, key: string): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await saveGitlabApplication(clientId.trim(), clientSecret.trim());
      window.location.assign(`/auth/${key}/login`);
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'the application was not saved');
      setBusy(false);
    }
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, mt: 8, px: 2 }}>
      <Box sx={{ textAlign: 'center' }}>
        <Typography variant="h5" component="h1">
          Connect swarmloop to your code host
        </Typography>
        <Typography color="text.secondary">
          Nothing to copy or paste: you sign in with it afterwards, and every run uses your own access.
        </Typography>
      </Box>
      {error ? <Alert severity="error">{error}</Alert> : null}
      {/* A new key per manifest: a second click (after coming back from the host) posts again. */}
      {form ? <ManifestPost key={form.action} form={form} /> : null}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, justifyContent: 'center', width: '100%', maxWidth: 900 }}>
        {HOST_TEXTS.map((entry) => (
          <Paper
            key={entry.key}
            variant="outlined"
            component="form"
            aria-label={entry.firstRun.title}
            onSubmit={(event) =>
              void (entry.firstRun.kind === 'manifest' ? createApp(event) : saveApplication(event, entry.key))
            }
            sx={{ p: 3, flex: '1 1 340px', display: 'flex', flexDirection: 'column', gap: 2 }}
          >
            <Typography variant="h6" component="h2">
              {entry.firstRun.title}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {entry.firstRun.description}
            </Typography>
            {entry.firstRun.kind === 'manifest' ? (
              <>
                <TextField
                  label="Account that owns the app"
                  size="small"
                  required
                  value={org}
                  onChange={(event) => {
                    typed.current = true;
                    setOrg(event.target.value);
                  }}
                />
                {others.length > 0 ? (
                  <Typography variant="body2" color="text.secondary">
                    The other owners ({others.join(', ')}) get their own app later.
                  </Typography>
                ) : null}
                <Button type="submit" variant="contained">
                  {entry.firstRun.submit}
                </Button>
              </>
            ) : (
              <>
                <TextField
                  label="Application ID"
                  size="small"
                  required
                  value={clientId}
                  onChange={(event) => setClientId(event.target.value)}
                />
                <TextField
                  label="Secret"
                  size="small"
                  type="password"
                  required
                  autoComplete="off"
                  value={clientSecret}
                  onChange={(event) => setClientSecret(event.target.value)}
                />
                <Button type="submit" variant="contained" disabled={busy}>
                  {entry.firstRun.submit}
                </Button>
              </>
            )}
          </Paper>
        ))}
      </Box>
    </Box>
  );
}
