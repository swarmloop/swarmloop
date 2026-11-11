'use client';

import type { FormEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { getManifest, saveGitlabApplication } from '../../lib/endpoints';

interface ManifestForm {
  action: string;
  manifest: Record<string, unknown>;
}

/** GitHub takes the manifest as a form post, so the page builds the form and sends it. */
function ManifestPost({ form }: { form: ManifestForm }): ReactElement {
  const ref = useRef<HTMLFormElement>(null);
  useEffect(() => ref.current?.submit(), []);
  return (
    <form ref={ref} method="post" action={form.action}>
      <input type="hidden" name="manifest" value={JSON.stringify(form.manifest)} />
    </form>
  );
}

/** The first screen of a server with no login yet: make the GitHub App, or hand over the GitLab application. */
export function FirstRun(): ReactElement {
  const [org, setOrg] = useState('');
  const [form, setForm] = useState<ManifestForm | null>(null);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function createGithubApp(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      setForm(await getManifest(org.trim()));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : 'the app could not be prepared');
    }
  }

  async function connectGitlab(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await saveGitlabApplication(clientId.trim(), clientSecret.trim());
      window.location.assign('/auth/gitlab/login');
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
      {/* A new key per manifest: a second click (after coming back from GitHub) posts again. */}
      {form ? <ManifestPost key={form.action} form={form} /> : null}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 3, justifyContent: 'center', width: '100%', maxWidth: 900 }}>
        <Paper
          variant="outlined"
          component="form"
          aria-label="Connect GitHub"
          onSubmit={(event) => void createGithubApp(event)}
          sx={{ p: 3, flex: '1 1 340px', display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          <Typography variant="h6" component="h2">
            Connect GitHub
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Creates a GitHub App for you, from a manifest. You then install it on the repositories you choose.
          </Typography>
          <TextField
            label="Organization that will own the app (optional)"
            helperText="Leave empty for your own account. To use the app on other accounts and organizations too, make it public on GitHub (Advanced, Make public) and install it there."
            size="small"
            value={org}
            onChange={(event) => setOrg(event.target.value)}
          />
          <Button type="submit" variant="contained">
            Create GitHub App
          </Button>
        </Paper>
        <Paper
          variant="outlined"
          component="form"
          aria-label="Connect GitLab"
          onSubmit={(event) => void connectGitlab(event)}
          sx={{ p: 3, flex: '1 1 340px', display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          <Typography variant="h6" component="h2">
            Connect GitLab
          </Typography>
          <Typography variant="body2" color="text.secondary">
            The OAuth application of your GitLab, with scopes read_user, api and write_repository.
          </Typography>
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
            Connect GitLab
          </Button>
        </Paper>
      </Box>
    </Box>
  );
}
