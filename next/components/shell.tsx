'use client';

import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import AddIcon from '@mui/icons-material/Add';
import DarkMode from '@mui/icons-material/DarkMode';
import DeleteOutline from '@mui/icons-material/DeleteOutline';
import LightMode from '@mui/icons-material/LightMode';
import Schedule from '@mui/icons-material/Schedule';
import SettingsBrightness from '@mui/icons-material/SettingsBrightness';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import Drawer from '@mui/material/Drawer';
import IconButton from '@mui/material/IconButton';
import List from '@mui/material/List';
import ListItem from '@mui/material/ListItem';
import ListItemButton from '@mui/material/ListItemButton';
import TextField from '@mui/material/TextField';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Toolbar from '@mui/material/Toolbar';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { useColorScheme } from '@mui/material/styles';
import { api } from '../lib/api';
import { duration, money, when } from '../lib/format';
import { liveSocket } from '../lib/live';
import { RunSummary } from '../lib/types';
import { statusColor } from '../theme/theme';
import { NewRunDialog } from './new-run-dialog';

const DrawerWidth = 280;

const DialogContext = createContext<() => void>(() => undefined);

export function useNewRun(): () => void {
  return useContext(DialogContext);
}

function openRunMs(run: RunSummary, now: number): number {
  if (run.status !== 'running' || !run.stepStartedAt) {
    return 0;
  }
  const started = Date.parse(run.stepStartedAt);
  return Number.isFinite(started) ? Math.max(0, now - started) : 0;
}

function ThemeModeSwitch() {
  const { mode, setMode } = useColorScheme();
  if (!mode) {
    return null;
  }
  return (
    <ToggleButtonGroup
      exclusive
      size="small"
      value={mode}
      aria-label="theme"
      onChange={(_event, value: 'light' | 'dark' | 'system' | null) => {
        if (value) {
          setMode(value);
        }
      }}
      sx={{ mr: 2 }}
    >
      <ToggleButton value="light" aria-label="light">
        <LightMode fontSize="small" />
      </ToggleButton>
      <ToggleButton value="system" aria-label="system">
        <SettingsBrightness fontSize="small" />
      </ToggleButton>
      <ToggleButton value="dark" aria-label="dark">
        <DarkMode fontSize="small" />
      </ToggleButton>
    </ToggleButtonGroup>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
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
  useEffect(() => {
    let stopped = false;
    const load = (): void => {
      api<{ runs: RunSummary[] }>('/runs')
        .then((body) => {
          if (!stopped) {
            setRuns(body.runs);
            setError(null);
          }
        })
        .catch((cause: unknown) => {
          if (!stopped) {
            setError(cause instanceof Error ? cause.message : 'api is not reachable');
          }
        });
    };
    load();
    const socket = liveSocket();
    const show = (): void => setConnected(true);
    const hide = (): void => setConnected(false);
    const apply = (body: { runs: RunSummary[] }): void => {
      if (!stopped) {
        setRuns(body.runs);
        setError(null);
      }
    };
    socket.on('connect', show);
    socket.on('disconnect', hide);
    socket.on('runs', apply);
    if (socket.connected) {
      show();
    }
    return () => {
      stopped = true;
      socket.off('connect', show);
      socket.off('disconnect', hide);
      socket.off('runs', apply);
    };
  }, []);
  const running = runs.some((run) => run.status === 'running');
  useEffect(() => {
    if (!running) {
      return;
    }
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

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
      await api(`/runs/${encodeURIComponent(key)}`, { method: 'DELETE' });
      setRuns((current) => current.filter((run) => run.key !== key));
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
          <Typography variant="h5" sx={{ flexGrow: 1, fontFamily: 'var(--font-sans)' }}>
            swarmloop
          </Typography>
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
        <Box sx={{ flex: 1, overflow: 'auto' }}>
        <Box sx={{ px: 1.5, pt: 1 }}>
          <TextField value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Filter by key" size="small" fullWidth />
        </Box>
        {visible.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, pt: 2 }}>
            {runs.length === 0 ? 'No runs yet.' : 'No key matches.'}
          </Typography>
        ) : null}
        <List sx={{ px: 0.5, py: 0.5 }}>
          {visible.map((run) => (
            <ListItem key={run.key} disablePadding disableGutters divider sx={{ mb: 1 }}>
            <ListItemButton
              component="div"
              selected={run.key === selected}
              onClick={() => router.push(`/runs/${run.key}`)}
              sx={{ alignItems: 'flex-start', py: 0.5, px: 1 }}
            >
              <Box sx={{ width: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'nowrap', minWidth: 0 }}>
                  <Tooltip title={run.name}>
                    <Typography noWrap sx={{ fontWeight: 500, fontSize: 14, flex: 1, minWidth: 0 }}>
                      {run.name}
                    </Typography>
                  </Tooltip>
                  <Tooltip title={run.currentStep}>
                    <Chip
                      size="small"
                      label={run.currentStep}
                      sx={{
                        maxWidth: '40%',
                        minWidth: 0,
                        flexShrink: 1,
                        overflow: 'hidden',
                        bgcolor: 'transparent',
                        color: statusColor(run.status),
                        border: 1,
                        borderColor: statusColor(run.status),
                        height: 18,
                        '& .MuiChip-label': { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 12, px: 0.75 },
                      }}
                    />
                  </Tooltip>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexWrap: 'nowrap', minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums', fontSize: 12, flexShrink: 0 }}>
                    {money(run.usd)}
                  </Typography>
                  <Tooltip title="Total time the steps have run. Reviewers that run together count as the slowest one, then the report and the remaining time in that step. Time waiting on a person, and time sitting idle after a failure, is not included.">
                    <Box
                      component="span"
                      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, flexShrink: 0, fontFamily: 'var(--font-mono)', fontSize: 12, color: 'text.secondary' }}
                    >
                      <Schedule sx={{ fontSize: 14 }} />
                      {duration(run.durationMs + openRunMs(run, now))}
                    </Box>
                  </Tooltip>
                  <Typography noWrap color="text.secondary" sx={{ fontSize: 12, minWidth: 0, ml: 'auto' }}>
                    {when(run.createdAt)}
                  </Typography>
                  <IconButton
                    size="small"
                    aria-label={`Remove ${run.name}`}
                    sx={{ color: 'text.secondary', p: 0, width: 22, height: 22, flexShrink: 0 }}
                    onClick={(event) => {
                      event.stopPropagation();
                      setRemoveError(null);
                      setPendingRemove(run);
                    }}
                  >
                    <DeleteOutline sx={{ fontSize: 16 }} />
                  </IconButton>
                </Box>
              </Box>
            </ListItemButton>
            </ListItem>
          ))}
        </List>
        {error ? (
          <Typography variant="body2" color="error" sx={{ px: 2 }}>
            {error}
          </Typography>
        ) : null}
        </Box>
      </Drawer>
      <Box component="main" sx={{ ml: `${DrawerWidth}px`, minHeight: '100vh' }}>
        <Toolbar />
        <Box sx={{ px: { xs: 2, md: 4 }, py: 3, maxWidth: 1180 }}>{children}</Box>
      </Box>
      <Dialog open={pendingRemove !== null} onClose={closeRemove} fullWidth maxWidth="xs">
        <DialogTitle>Remove {pendingRemove?.name}?</DialogTitle>
        <DialogContent>
          <Typography>This deletes the run's saved rows and files.</Typography>
          {removeError ? (
            <Typography color="error" variant="body2" sx={{ mt: 1 }}>
              {removeError}
            </Typography>
          ) : null}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={closeRemove} disabled={removing}>
            Cancel
          </Button>
          <Button color="error" variant="contained" disabled={removing || !pendingRemove} onClick={() => void confirmRemove()}>
            Remove
          </Button>
        </DialogActions>
      </Dialog>
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
