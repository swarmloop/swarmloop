'use client';

import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import { FirstRun } from '../../features/connections';
import { getInstallUrl, getProviders } from '../../lib/endpoints';
import { hostOf, installHost } from './hosts';
import { LoginProblemAlert } from './login-problem-alert';

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
      <Button href={`/auth/${installHost()}/login`}>Log in</Button>
    </>
  );
}

/** An install started on the host's own page comes back here: it is done, not an error. */
function InstalledReturn({ account }: { account: string }): ReactElement {
  return (
    <>
      <Typography variant="h6" component="h2">
        {account ? `Installed on ${account}` : 'Installed'}
      </Typography>
      <Button variant="contained" href={`/auth/${installHost()}/login`}>
        Log in
      </Button>
    </>
  );
}

function Logo(): ReactElement {
  return <Box component="img" src="/logo.svg" alt="" width={48} height={48} sx={{ display: 'block' }} />;
}

function loginHref(provider: string, next: string | null): string {
  return next ? `/auth/${provider}/login?next=${encodeURIComponent(next)}` : `/auth/${provider}/login`;
}

/** One button for each login provider the server has configured. */
function ProviderButtons({ providers, next }: { providers: string[]; next: string | null }): ReactElement {
  const first = useRef<HTMLAnchorElement>(null);

  // Not autoFocus (jsx-a11y forbids it): the first button takes focus once the providers have loaded.
  useEffect(() => {
    first.current?.focus();
  }, []);

  return (
    <>
      {providers.map((provider, index) => {
        const { label, Mark } = hostOf(provider);
        return (
          <Button
            key={provider}
            ref={index === 0 ? first : undefined}
            fullWidth
            variant="outlined"
            href={loginHref(provider, next)}
            startIcon={<Mark />}
          >
            Continue with {label}
          </Button>
        );
      })}
    </>
  );
}

function LoadingButtons(): ReactElement {
  return (
    <>
      <Skeleton variant="rounded" width="100%" height={36} />
      <Skeleton variant="rounded" width="100%" height={36} />
    </>
  );
}

export default function LoginPage(): ReactElement {
  const [providers, setProviders] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [install, setInstall] = useState(false);
  const [installed, setInstalled] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    setProviders(null);
    getProviders().then(
      (view) => setProviders(view.providers),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : 'api is not reachable'),
    );
  }, []);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setInstall(query.get('install') === '1');
    setInstalled(query.get('installed'));
    setNext(query.get('next'));
    load();
  }, [load]);

  const step = installed !== null ? <InstalledReturn account={installed} /> : install ? <InstallStep /> : null;
  const firstRun = step === null && providers?.length === 0;

  let choice: ReactElement;
  if (step !== null) {
    choice = step;
  } else if (error) {
    choice = (
      <Alert severity="error" sx={{ width: '100%' }} action={<Button onClick={load}>Try again</Button>}>
        {error}
      </Alert>
    );
  } else if (providers === null) {
    choice = <LoadingButtons />;
  } else {
    choice = <ProviderButtons providers={providers} next={next} />;
  }

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <Paper
        sx={{
          bgcolor: 'background.paper',
          color: 'text.secondary',
          p: 4,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2,
          ...(firstRun ? { width: '100%', maxWidth: 900 } : { width: 'min(400px, 100% - 32px)' }),
        }}
      >
        <Logo />
        {firstRun ? (
          <FirstRun />
        ) : (
          <>
            <Typography variant="h5" component="h1" color="text.primary">
              Log in to swarmloop
            </Typography>
            <Typography variant="body2" color="text.secondary" align="center">
              Coding agents that pass five reviewers and your CI before they reach you.
            </Typography>
            <LoginProblemAlert />
            {choice}
            <Typography variant="caption" color="text.secondary">
              Only accounts this server allows can log in.
            </Typography>
          </>
        )}
      </Paper>
    </Box>
  );
}
