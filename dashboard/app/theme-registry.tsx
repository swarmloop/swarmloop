'use client';

import { useState } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppRouterCacheProvider } from '@mui/material-nextjs/v15-appRouter';
import CssBaseline from '@mui/material/CssBaseline';
import { ThemeProvider } from '@mui/material/styles';
import { ApiError } from '../lib/api';
import { theme } from '../theme/theme';

const RETRIES = 3;
const RETRY_DELAY_CAP_MS = 30_000;

/** A busy server is retried for as long as it stays busy; any other error gets three more tries. */
const retry = (failureCount: number, error: Error): boolean =>
  (error instanceof ApiError && error.busy) || failureCount < RETRIES;

const retryDelay = (attempt: number): number => Math.min(1000 * 2 ** attempt, RETRY_DELAY_CAP_MS);

export function ThemeRegistry({ children }: { children: React.ReactNode }): React.ReactElement {
  const [queries] = useState(() => new QueryClient({ defaultOptions: { queries: { retry, retryDelay } } }));
  return (
    <AppRouterCacheProvider>
      <ThemeProvider theme={theme} defaultMode="system">
        <CssBaseline />
        <QueryClientProvider client={queries}>{children}</QueryClientProvider>
      </ThemeProvider>
    </AppRouterCacheProvider>
  );
}
