'use client';

import type { ReactElement } from 'react';
import Link from 'next/link';
import AddIcon from '@mui/icons-material/Add';
import MenuIcon from '@mui/icons-material/Menu';
import AppBar from '@mui/material/AppBar';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import IconButton from '@mui/material/IconButton';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import type { ReadinessItem } from '@contract/readiness';
import { ReadinessStatus } from '../features/readiness';
import { MainNav } from '../features/shell';

interface DashboardHeaderProps {
  connected: boolean;
  blocker: ReadinessItem | null;
  onNewRun: () => void;
  onMenu: () => void;
  phone: boolean;
  menuLabel: string;
}

/** The top bar: the logo, and on a desktop the main nav and readiness; on a phone the menu button and a New run icon. */
export function DashboardHeader({
  connected,
  blocker,
  onNewRun,
  onMenu,
  phone,
  menuLabel,
}: DashboardHeaderProps): ReactElement {
  return (
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
        {phone ? (
          <IconButton edge="start" aria-label={menuLabel} onClick={onMenu}>
            <MenuIcon />
          </IconButton>
        ) : null}
        <Box>
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
        {phone ? null : <MainNav />}
        <Box sx={{ flexGrow: 1 }} />
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mr: phone ? 1 : 2 }}>
          <Box
            component="span"
            role={phone ? 'img' : undefined}
            aria-label={phone ? (connected ? 'live' : 'offline') : undefined}
            sx={{
              width: 7,
              height: 7,
              borderRadius: '50%',
              bgcolor: connected ? 'primary.main' : 'text.disabled',
              animation: connected ? 'swarmloop-pulse 1.6s ease-in-out infinite' : 'none',
            }}
          />
          {phone ? null : (
            <Typography variant="body2" color="text.secondary">
              {connected ? 'live' : 'offline'}
            </Typography>
          )}
        </Box>
        {phone ? null : <ReadinessStatus />}
        <Box component="span" title={blocker?.action}>
          {phone ? (
            <IconButton aria-label="New run" color="primary" onClick={onNewRun} disabled={blocker !== null}>
              <AddIcon />
            </IconButton>
          ) : (
            <Button variant="contained" startIcon={<AddIcon />} onClick={onNewRun} disabled={blocker !== null}>
              New run
            </Button>
          )}
        </Box>
      </Toolbar>
    </AppBar>
  );
}
