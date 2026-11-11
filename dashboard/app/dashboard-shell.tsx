'use client';

import type { ReactElement } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import type { RunSummary } from '@contract/api';
import { NewRunDialog } from '../features/new-run';
import { useReadiness } from '../features/readiness';
import { RemoveRunDialog, RunList, useRuns } from '../features/runs';
import { Account, Shell, ThemeModeSwitch, useNewRun } from '../features/shell';

const DrawerWidth = 280;

export function DashboardShell({ children }: { children: React.ReactNode }): ReactElement {
  const [open, setOpen] = useState(false);
  // The login page has no runs to list and no socket to open: nobody is logged in yet.
  if (usePathname() === '/login') {
    return <>{children}</>;
  }
  return (
    <Shell onNewRun={() => setOpen(true)}>
      <DashboardFrame open={open} setOpen={setOpen}>
        {children}
      </DashboardFrame>
    </Shell>
  );
}

function DashboardFrame({
  children,
  open,
  setOpen,
}: {
  children: React.ReactNode;
  open: boolean;
  setOpen: (open: boolean) => void;
}): ReactElement {
  const pathname = usePathname();
  const router = useRouter();
  const { runs, now, error, connected, removeRun } = useRuns();
  const openNewRun = useNewRun();
  const { blocker } = useReadiness();
  const [query, setQuery] = useState('');
  const [pendingRemove, setPendingRemove] = useState<RunSummary | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const matched = pathname.match(/^\/runs\/([^/]+)/)?.[1] ?? '';
  let selected = matched;
  try {
    selected = decodeURIComponent(matched);
  } catch {
    selected = matched;
  }
  const visible = useMemo(
    () => runs.filter((run) => run.key.toLowerCase().includes(query.trim().toLowerCase())),
    [runs, query],
  );

  function closeRemove(): void {
    if (removing) {
      return;
    }
    setPendingRemove(null);
    setRemoveError(null);
  }

  async function confirmRemove(): Promise<void> {
    if (!pendingRemove) {
      return;
    }
    const key = pendingRemove.key;
    setRemoving(true);
    setRemoveError(null);
    try {
      await removeRun(key);
      setPendingRemove(null);
      if (selected === key) {
        router.push('/');
      }
    } catch (cause: unknown) {
      setRemoveError(cause instanceof Error ? cause.message : 'remove failed');
    } finally {
      setRemoving(false);
    }
  }

  return (
    <>
      <AppBar
        position="fixed"
        sx={{
          bgcolor: 'background.paper',
          borderBottom: 1,
          borderColor: 'divider',
          zIndex: (theme) => theme.zIndex.drawer + 1,
        }}
      >
        <Toolbar>
          <Box sx={{ flexGrow: 1 }}>
            <Box
              component={Link}
              href="/"
              aria-label="swarmloop, overview"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 1.25,
                color: 'inherit',
                textDecoration: 'none',
                borderRadius: 1,
                '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
              }}
            >
              <Box component="img" src="/logo.svg" alt="" width={36} height={36} sx={{ display: 'block' }} />
              <Typography variant="h5" sx={{ fontFamily: 'var(--font-sans)' }}>
                swarmloop
              </Typography>
            </Box>
          </Box>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mr: 2 }}>
            <Box
              component="span"
              sx={{
                width: 7,
                height: 7,
                borderRadius: '50%',
                bgcolor: connected ? 'primary.main' : 'text.disabled',
                animation: connected ? 'swarmloop-pulse 1.6s ease-in-out infinite' : 'none',
              }}
            />
            <Typography variant="body2" color="text.secondary">
              {connected ? 'live' : 'offline'}
            </Typography>
          </Box>
          <Account />
          <ThemeModeSwitch />
          <Box component="span" title={blocker?.action}>
            <Button variant="contained" startIcon={<AddIcon />} onClick={openNewRun} disabled={blocker !== null}>
              New run
            </Button>
          </Box>
        </Toolbar>
      </AppBar>
      <Drawer
        variant="permanent"
        sx={{
          width: DrawerWidth,
          flexShrink: 0,
          '& .MuiDrawer-paper': {
            width: DrawerWidth,
            boxSizing: 'border-box',
            bgcolor: 'background.paper',
            borderRight: 1,
            borderColor: 'divider',
            display: 'flex',
            flexDirection: 'column',
          },
        }}
      >
        <Toolbar />
        <RunList
          query={query}
          onQuery={setQuery}
          runs={runs}
          visible={visible}
          selected={selected}
          now={now}
          error={error}
          onOpen={(key) => router.push(`/runs/${key}` as Route)}
          onRemove={(run) => {
            setRemoveError(null);
            setPendingRemove(run);
          }}
        />
      </Drawer>
      <Box component="main" sx={{ ml: `${DrawerWidth}px`, minHeight: '100vh', minWidth: 0 }}>
        <Toolbar />
        <Box sx={{ px: { xs: 2, md: 4 }, py: 3, maxWidth: 1180, minWidth: 0 }}>{children}</Box>
      </Box>
      <RemoveRunDialog
        run={pendingRemove}
        removing={removing}
        error={removeError}
        onClose={closeRemove}
        onConfirm={() => void confirmRemove()}
      />
      <NewRunDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={(key) => {
          setOpen(false);
          router.push(`/runs/${key}` as Route);
        }}
      />
    </>
  );
}
