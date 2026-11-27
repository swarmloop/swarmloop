'use client';

import type { FormEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { TokenSignInView } from '@contract/api';
import type { ApplicationSetupView } from '@contract/host-login';
import { getManifest, getOwner } from '../../lib/endpoints';
import { ApplicationForm } from './application-form';
import { HOST_TEXTS } from './logos';
import { TokenSignIn } from './token-sign-in';

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
export function FirstRun({
  tokens = [],
  applications = [],
  next = null,
}: {
  tokens?: TokenSignInView[];
  applications?: ApplicationSetupView[];
  next?: string | null;
}): ReactElement {
  const [org, setOrg] = useState('');
  const [others, setOthers] = useState<string[]>([]);
  const typed = useRef(false);
  const [form, setForm] = useState<ManifestForm | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        {HOST_TEXTS.map((entry) => {
          const heading = (
            <>
              <Typography variant="h6" component="h2">
                {entry.firstRun.title}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {entry.firstRun.description}
              </Typography>
            </>
          );
          const cardSx = { p: 3, flex: '1 1 340px', display: 'flex', flexDirection: 'column', gap: 2 } as const;
          if (entry.firstRun.kind === 'manifest') {
            return (
              <Paper
                key={entry.key}
                variant="outlined"
                component="form"
                aria-label={entry.firstRun.title}
                onSubmit={(event) => void createApp(event)}
                sx={cardSx}
              >
                {heading}
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
              </Paper>
            );
          }
          const tokenEntry = tokens.find((item) => item.provider === entry.key);
          const setup = applications.find((item) => item.provider === entry.key);
          return (
            <Paper key={entry.key} variant="outlined" component="section" aria-label={entry.firstRun.title} sx={cardSx}>
              {heading}
              {tokenEntry ? (
                <>
                  <Typography variant="subtitle2">Recommended</Typography>
                  <TokenSignIn entry={tokenEntry} label={entry.label} next={next} />
                </>
              ) : null}
              {tokenEntry && setup && entry.application ? (
                <Divider flexItem>Or, for a team that wants OAuth</Divider>
              ) : null}
              {setup && entry.application ? (
                <ApplicationForm
                  setup={setup}
                  label={entry.label}
                  texts={entry.application}
                  onSaved={() => window.location.assign(`/auth/${entry.key}/login`)}
                />
              ) : null}
            </Paper>
          );
        })}
      </Box>
    </Box>
  );
}
