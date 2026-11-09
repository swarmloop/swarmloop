'use client';

import type { ReactElement } from 'react';
import type { Route } from 'next';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import AddIcon from '@mui/icons-material/Add';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import type { DrainView, RunSummary } from '@contract/api';
import { NewRunDialog } from '../features/new-run';
import { useReadiness } from '../features/readiness';
import { RemoveRunDialog, RunList, useRuns } from '../features/runs';
import { getDrain, startDrain } from '../lib/endpoints';
import { Shell, ThemeModeSwitch, useNewRun } from '../features/shell';

const DrawerWidth = 280;
const DrainPollMs = 2000;

function drainLabel(drain: DrainView | null): string {
  if (!drain?.draining) {
    return 'Drain';
  }
  return drain.idle ? 'Idle: safe to upgrade' : `Draining: ${drain.running} running`;
}

export function DashboardShell({ children }: { children: React.ReactNode }): ReactElement {
  const [open, setOpen] = useState(false);
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
  const [drain, setDrain] = useState<DrainView | null>(null);
  const [drainError, setDrainError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!drain?.draining || drain.idle) {
      return;
    }
    const timer = setTimeout(() => {
      getDrain().then(setDrain, (cause: unknown) =>
        setDrainError(cause instanceof Error ? cause.message : 'drain failed'),
      );
    }, DrainPollMs);
    return () => clearTimeout(timer);
  }, [drain]);

  async function beginDrain(): Promise<void> {
    setDrainError(null);
    try {
      setDrain(await startDrain());
    } catch (cause: unknown) {
      setDrainError(cause instanceof Error ? cause.message : 'drain failed');
    }
  }

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
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, flexGrow: 1 }}>
            <Box component="img" src="/logo.svg" alt="" width={36} height={36} sx={{ display: 'block' }} />
            <Typography variant="h5" sx={{ fontFamily: 'var(--font-sans)' }}>
              swarmloop
            </Typography>
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
          <ThemeModeSwitch />
          <Box component="span" title={drainError ?? 'Stop taking new runs and steps before an upgrade'} sx={{ mr: 1 }}>
            <Button
              variant="outlined"
              color={drainError ? 'error' : 'primary'}
              onClick={() => void beginDrain()}
              disabled={drain?.draining === true}
            >
              {drainLabel(drain)}
            </Button>
          </Box>
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
