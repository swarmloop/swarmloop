'use client';

import type { ComponentType, ReactElement } from 'react';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import UnfoldMore from '@mui/icons-material/UnfoldMore';

export interface AccountHost {
  label: string;
  Mark: ComponentType;
}

interface AccountTriggerProps {
  login: string;
  avatarUrl: string | null | undefined;
  host: AccountHost | null;
  open: boolean;
  panelId: string;
  onOpen: (element: HTMLElement) => void;
}

/** The signed-in person as a full-width row at the bottom of the sidebar; a placeholder of the same size while no person is known. */
export function AccountTrigger({ login, avatarUrl, host, open, panelId, onOpen }: AccountTriggerProps): ReactElement {
  return (
    <ButtonBase
      aria-label={login ? undefined : 'Account menu'}
      aria-haspopup="menu"
      aria-expanded={open}
      aria-controls={panelId}
      onClick={(event) => onOpen(event.currentTarget)}
      sx={{
        width: '100%',
        justifyContent: 'flex-start',
        gap: 1.25,
        px: 2,
        py: 1.5,
        textAlign: 'left',
        borderRadius: 'var(--mui-shape-borderRadius)',
        bgcolor: open ? 'action.hover' : 'transparent',
        '&:hover': { bgcolor: 'action.hover' },
      }}
    >
      {login ? (
        <>
          <Avatar
            src={avatarUrl ?? undefined}
            alt=""
            sx={{ width: 32, height: 32, fontSize: 14, boxShadow: '0 0 0 1px var(--mui-palette-divider)' }}
          >
            {login.slice(0, 2).toUpperCase()}
          </Avatar>
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Typography variant="body2" noWrap>
              {login}
            </Typography>
            {host ? (
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, color: 'text.secondary' }}>
                <Box component="span" sx={{ display: 'inline-flex', '& svg': { width: 14, height: 14 } }}>
                  <host.Mark />
                </Box>
                <Typography variant="caption" color="text.secondary" noWrap>
                  {host.label}
                </Typography>
              </Box>
            ) : null}
          </Box>
        </>
      ) : (
        <>
          <Skeleton variant="circular" width={32} height={32} />
          <Box sx={{ minWidth: 0, flex: 1 }}>
            <Skeleton variant="text" width={88} />
          </Box>
        </>
      )}
      <UnfoldMore fontSize="small" sx={{ color: 'text.secondary' }} />
    </ButtonBase>
  );
}
