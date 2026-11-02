'use client';

import { createContext, useContext, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import AddIcon from '@mui/icons-material/Add';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Drawer from '@mui/material/Drawer';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import { useLive } from '../../hooks/use-live';
import { RunSummary } from '../../lib/types';
import { NewRunDialog } from '../new-run-dialog';
import { RemoveRunDialog } from './remove-run-dialog';
import { RunList } from './run-list';
import { ThemeModeSwitch } from './theme-mode-switch';

const DrawerWidth = 280;

const DialogContext = createContext<() => void>(() => undefined);

export function useNewRun(): () => void {
  return useContext(DialogContext);
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { runs, now, error, connected, removeRun } = useLive();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
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
  const visible = useMemo(() => runs.filter((run) => run.key.toLowerCase().includes(query.trim().toLowerCase())), [runs, query]);

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
    <DialogContext.Provider value={() => setOpen(true)}>
      <AppBar position="fixed" sx={{ bgcolor: 'background.paper', borderBottom: 1, borderColor: 'divider', zIndex: (theme) => theme.zIndex.drawer + 1 }}>
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
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setOpen(true)}>
            New run
          </Button>
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
          onOpen={(key) => router.push(`/runs/${key}`)}
          onRemove={(run) => {
            setRemoveError(null);
            setPendingRemove(run);
          }}
        />
      </Drawer>
      <Box component="main" sx={{ ml: `${DrawerWidth}px`, minHeight: '100vh' }}>
        <Toolbar />
        <Box sx={{ px: { xs: 2, md: 4 }, py: 3, maxWidth: 1180 }}>{children}</Box>
      </Box>
      <RemoveRunDialog run={pendingRemove} removing={removing} error={removeError} onClose={closeRemove} onConfirm={() => void confirmRemove()} />
      <NewRunDialog
        open={open}
        onClose={() => setOpen(false)}
        onCreated={(key) => {
          setOpen(false);
          router.push(`/runs/${key}`);
        }}
      />
    </DialogContext.Provider>
  );
}
