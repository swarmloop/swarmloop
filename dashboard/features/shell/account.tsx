'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Typography from '@mui/material/Typography';
import type { MeView } from '@contract/api';
import { getSession, logout } from '../../lib/endpoints';
import { ThemeModeSwitch } from './theme-mode-switch';

/** The signed-in person as a button; it opens Settings, Connections, the theme switch and Log out. */
export function Account(): ReactElement {
  const [me, setMe] = useState<MeView | null>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    getSession().then(setMe, () => setMe(null));
  }, []);

  const login = me?.user ?? '';
  return (
    <>
      <ButtonBase
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={(event) => setAnchor(event.currentTarget)}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: 1.25, px: 2, py: 1.5, textAlign: 'left' }}
      >
        <Avatar src={me?.avatarUrl ?? undefined} alt="" sx={{ width: 32, height: 32, fontSize: 14 }}>
          {login.slice(0, 2).toUpperCase()}
        </Avatar>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="body2" noWrap>
            {login || 'Account'}
          </Typography>
          {me?.provider ? (
            <Typography variant="caption" color="text.secondary" noWrap>
              {me.provider}
            </Typography>
          ) : null}
        </Box>
      </ButtonBase>
      <Menu
        open={anchor !== null}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <MenuItem component={Link} href="/settings" onClick={() => setAnchor(null)}>
          Settings
        </MenuItem>
        <MenuItem component={Link} href="/connections" onClick={() => setAnchor(null)}>
          Connections
        </MenuItem>
        <Box sx={{ px: 2, py: 1 }}>
          <ThemeModeSwitch />
        </Box>
        <MenuItem onClick={() => void logout().finally(() => window.location.assign('/login'))}>Log out</MenuItem>
      </Menu>
    </>
  );
}
