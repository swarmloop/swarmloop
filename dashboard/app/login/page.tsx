'use client';

import type { ReactElement } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import type { TokenSignInView } from '@contract/api';
import type { ApplicationSetupView } from '@contract/host-login';
import { ApplicationForm, FirstRun, hostTexts, TokenSignIn } from '../../features/connections';
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

/** The button of a login provider the server has configured. */
function ContinueButton({
  provider,
  next,
  focus,
}: {
  provider: string;
  next: string | null;
  focus: boolean;
}): ReactElement {
  const ref = useRef<HTMLAnchorElement>(null);
  const { label, Mark } = hostOf(provider);

  // Not autoFocus (jsx-a11y forbids it): the first button takes focus once the providers have loaded.
  useEffect(() => {
    if (focus) {
      ref.current?.focus();
    }
  }, [focus]);

  return (
    <Button ref={ref} fullWidth variant="outlined" href={loginHref(provider, next)} startIcon={<Mark />}>
      Continue with {label}
    </Button>
  );
}

/** A token sign-in for each host that takes one, with that host's Continue button under it when it is configured. */
function TokenBlocks({
  tokens,
  providers,
  next,
  focused,
}: {
  tokens: TokenSignInView[];
  providers: string[];
  next: string | null;
  focused: string | undefined;
}): ReactElement {
  return (
    <>
      {tokens.map((entry) => {
        const { label, Mark } = hostOf(entry.provider);
        return (
          <Box key={entry.provider} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, width: '100%' }}>
            <Typography variant="subtitle1" component="h2" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Mark />
              {label}
            </Typography>
            <TokenSignIn entry={entry} label={label} next={next} />
            {providers.includes(entry.provider) ? (
              <ContinueButton provider={entry.provider} next={next} focus={focused === entry.provider} />
            ) : null}
          </Box>
        );
      })}
    </>
  );
}

/** The plain buttons of the hosts without a token entry, an or line, then a block for each host with one. */
function LoginChoice({
  providers,
  tokens,
  next,
}: {
  providers: string[];
  tokens: TokenSignInView[];
  next: string | null;
}): ReactElement {
  const plain = providers.filter((provider) => !tokens.some((entry) => entry.provider === provider));
  const focused = plain[0] ?? tokens.find((entry) => providers.includes(entry.provider))?.provider;
  return (
    <>
      {plain.map((provider) => (
        <ContinueButton key={provider} provider={provider} next={next} focus={focused === provider} />
      ))}
      {plain.length > 0 && tokens.length > 0 ? <Divider flexItem>or</Divider> : null}
      <TokenBlocks tokens={tokens} providers={providers} next={next} focused={focused} />
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
  const [tokens, setTokens] = useState<TokenSignInView[]>([]);
  const [applications, setApplications] = useState<ApplicationSetupView[]>([]);
  const [replace, setReplace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [install, setInstall] = useState(false);
  const [installed, setInstalled] = useState<string | null>(null);
  const [next, setNext] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    setProviders(null);
    getProviders().then(
      (view) => {
        setTokens(view.tokens);
        setApplications(view.applications ?? []);
        setProviders(view.providers);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : 'api is not reachable'),
    );
  }, []);

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    setInstall(query.get('install') === '1');
    setInstalled(query.get('installed'));
    setNext(query.get('next'));
    setReplace(query.get('replace'));
    load();
  }, [load]);

  const step = installed !== null ? <InstalledReturn account={installed} /> : install ? <InstallStep /> : null;
  const firstRun = step === null && providers?.length === 0;

  const replaceSetup = applications.find((item) => item.provider === replace);
  const replaceTexts = replaceSetup ? hostTexts(replaceSetup.provider)?.application : undefined;

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
  } else if (replaceSetup && replaceTexts) {
    choice = (
      <ApplicationForm
        setup={replaceSetup}
        label={hostOf(replaceSetup.provider).label}
        texts={replaceTexts}
        replacing={{ name: 'OAuth application', connected: [] }}
        onSaved={() => window.location.assign(`/auth/${replaceSetup.provider}/login`)}
      />
    );
  } else {
    choice = <LoginChoice providers={providers} tokens={tokens} next={next} />;
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
          <>
            <LoginProblemAlert />
            <FirstRun tokens={tokens} applications={applications} next={next} />
          </>
        ) : (
          <>
            <Typography variant="h5" component="h1" color="text.primary">
              Log in to swarmloop
            </Typography>
            <Typography variant="body2" color="text.secondary" align="center">
              Coding agents that pass three reviewers and your CI before they reach you.
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
