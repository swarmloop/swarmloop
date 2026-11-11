'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { FirstRun } from '../../features/connections';
import { getProviders } from '../../lib/endpoints';

const LABELS: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab' };

/** One button for each login provider the server has configured. */
export default function LoginPage(): ReactElement {
  const [providers, setProviders] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getProviders().then(
      (view) => setProviders(view.providers),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : 'api is not reachable'),
    );
  }, []);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, mt: 12 }}>
      <Typography variant="h5" component="h1">
        Log in to swarmloop
      </Typography>
      {error ? <Typography color="error">{error}</Typography> : null}
      {providers?.length === 0 ? <FirstRun /> : null}
      {(providers ?? []).map((provider) => (
        <Button key={provider} variant="contained" href={`/auth/${provider}/login`}>
          Log in with {LABELS[provider] ?? provider}
        </Button>
      ))}
    </Box>
  );
}
