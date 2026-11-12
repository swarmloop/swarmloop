'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { FirstRun } from '../../features/connections';
import { getInstallUrl, getProviders } from '../../lib/endpoints';

const LABELS: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab' };

/** The next step after the app is made: install it on the repositories, then log in. */
function InstallStep(): ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Asking sets the state cookie of the login, so it happens before the click.
  useEffect(() => {
    getInstallUrl().then(
      (view) => setUrl(view.url),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : 'the install page could not be opened'),
    );
  }, []);

  return (
    <>
      <Typography variant="h6" component="h2">
        Install the app on your repositories
      </Typography>
      {error ? <Typography color="error">{error}</Typography> : null}
      {url ? (
        <Button variant="contained" href={url}>
          Install the app
        </Button>
      ) : null}
      <Button href="/auth/github/login">Log in</Button>
    </>
  );
}

/** An install started on GitHub's own page comes back here: it is done, not an error. */
function InstalledReturn({ account }: { account: string }): ReactElement {
  return (
    <>
      <Typography variant="h6" component="h2">
        {account ? `Installed on ${account}` : 'Installed'}
      </Typography>
      <Button variant="contained" href="/auth/github/login">
        Log in
      </Button>
    </>
  );
}

/** One button for each login provider the server has configured. */
export default function LoginPage(): ReactElement {
  const [providers, setProviders] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [install, setInstall] = useState(false);
  const [installed, setInstalled] = useState<string | null>(null);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setInstall(query.get('install') === '1');
    setInstalled(query.get('installed'));
    getProviders().then(
      (view) => setProviders(view.providers),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : 'api is not reachable'),
    );
  }, []);

  const step = installed !== null ? <InstalledReturn account={installed} /> : install ? <InstallStep /> : null;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, mt: 12 }}>
      <Typography variant="h5" component="h1">
        Log in to swarmloop
      </Typography>
      {error ? <Typography color="error">{error}</Typography> : null}
      {step}
      {step === null && providers?.length === 0 ? <FirstRun /> : null}
      {step === null
        ? (providers ?? []).map((provider) => (
            <Button key={provider} variant="contained" href={`/auth/${provider}/login`}>
              Log in with {LABELS[provider] ?? provider}
            </Button>
          ))
        : null}
    </Box>
  );
}
