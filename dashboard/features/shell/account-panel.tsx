'use client';

import type { ReactElement, ReactNode } from 'react';
import { useRef } from 'react';
import Link from 'next/link';
import Avatar from '@mui/material/Avatar';
import Box from '@mui/material/Box';
import Divider from '@mui/material/Divider';
import Drawer from '@mui/material/Drawer';
import Fade from '@mui/material/Fade';
import MenuItem from '@mui/material/MenuItem';
import Popover from '@mui/material/Popover';
import Skeleton from '@mui/material/Skeleton';
import Typography from '@mui/material/Typography';
import useMediaQuery from '@mui/material/useMediaQuery';
import { keyframes } from '@mui/material/styles';
import LogoutOutlined from '@mui/icons-material/LogoutOutlined';
import MenuBookOutlined from '@mui/icons-material/MenuBookOutlined';
import PowerOutlined from '@mui/icons-material/PowerOutlined';
import SettingsOutlined from '@mui/icons-material/SettingsOutlined';
import { logout } from '../../lib/endpoints';
import { usePhone } from '../../lib/use-phone';
import { readmeUrl } from './account-links';
import { AccountVersion } from './account-version';
import { AccountTheme } from './account-theme';
import type { AccountHost } from './account-trigger';
import { useMenuKeys } from './menu-keys';

const rise = keyframes`
  from { transform: translateY(4px); }
  to { transform: translateY(0); }
`;

const MIN_WIDTH = 260;

interface AccountPanelProps {
  id: string;
  anchor: HTMLElement | null;
  onClose: () => void;
  login: string;
  avatarUrl: string | null | undefined;
  host: AccountHost | null;
  version: string;
  revision: string | undefined;
  sourceUrl: string | null;
  needsAttention: boolean;
}

function Row({ icon, children, hint }: { icon: ReactNode; children: ReactNode; hint?: ReactNode }): ReactElement {
  return (
    <>
      <Box component="span" sx={{ display: 'inline-flex', color: 'text.secondary', '& svg': { fontSize: 18 } }}>
        {icon}
      </Box>
      <Box component="span" sx={{ flex: 1 }}>
        {children}
      </Box>
      {hint}
    </>
  );
}

const itemSx = { height: 36, minHeight: 36, gap: 1.5, px: 2, typography: 'body2' } as const;

function AccountMenu(props: AccountPanelProps): ReactElement {
  const { login, avatarUrl, host, version, revision, sourceUrl, needsAttention, onClose } = props;
  const list = useRef<HTMLDivElement>(null);
  const { onKeyDown } = useMenuKeys(list);
  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 2 }}>
        {login ? (
          <>
            <Avatar
              src={avatarUrl ?? undefined}
              alt=""
              sx={{ width: 40, height: 40, boxShadow: '0 0 0 1px var(--mui-palette-divider)' }}
            >
              {login.slice(0, 2).toUpperCase()}
            </Avatar>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap>
                {login}
              </Typography>
              {host ? (
                <Typography variant="caption" color="text.secondary" noWrap>
                  {`${host.label} · signed in`}
                </Typography>
              ) : null}
            </Box>
          </>
        ) : (
          <>
            <Skeleton variant="circular" width={40} height={40} />
            <Skeleton variant="text" width={96} />
          </>
        )}
      </Box>
      <Divider />
      <Box ref={list} role="menu" aria-label="Account" onKeyDown={onKeyDown} sx={{ py: 0.5 }}>
        <MenuItem component={Link} href="/settings" tabIndex={-1} onClick={onClose} sx={itemSx}>
          <Row icon={<SettingsOutlined />}>Settings</Row>
        </MenuItem>
        <MenuItem component={Link} href="/connections" tabIndex={-1} onClick={onClose} sx={itemSx}>
          <Row
            icon={<PowerOutlined />}
            hint={
              needsAttention ? (
                <Box
                  component="span"
                  aria-hidden
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, color: 'text.secondary' }}
                >
                  <Box sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'warning.main' }} />
                  <Typography variant="caption">Needs attention</Typography>
                </Box>
              ) : undefined
            }
          >
            Connections
          </Row>
        </MenuItem>
        <Divider sx={{ my: 0.5 }} />
        <AccountTheme />
        <Divider sx={{ my: 0.5 }} />
        {sourceUrl ? (
          <MenuItem
            component="a"
            href={readmeUrl(sourceUrl)}
            target="_blank"
            rel="noreferrer"
            tabIndex={-1}
            onClick={onClose}
            sx={itemSx}
          >
            <Row icon={<MenuBookOutlined />}>Documentation</Row>
          </MenuItem>
        ) : null}
        <MenuItem
          tabIndex={-1}
          onClick={() => void logout().finally(() => window.location.assign('/login'))}
          sx={{ ...itemSx, color: 'text.secondary' }}
        >
          <Row icon={<LogoutOutlined />}>Log out</Row>
        </MenuItem>
      </Box>
      <Divider />
      <Box sx={{ px: 2, py: 1 }}>
        <AccountVersion version={version} revision={revision} sourceUrl={sourceUrl} />
      </Box>
    </>
  );
}

/** The account menu: a popover that opens upward from the trigger, or a bottom sheet below 900 px. */
export function AccountPanel(props: AccountPanelProps): ReactElement {
  const { id, anchor, onClose } = props;
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const phone = usePhone();
  if (phone) {
    return (
      <Drawer
        id={id}
        anchor="bottom"
        open={anchor !== null}
        onClose={onClose}
        slotProps={{ paper: { sx: { borderRadius: '12px 12px 0 0', backgroundImage: 'none' } } }}
      >
        <AccountMenu {...props} />
      </Drawer>
    );
  }
  return (
    <Popover
      id={id}
      open={anchor !== null}
      anchorEl={anchor}
      onClose={onClose}
      anchorOrigin={{ vertical: 'top', horizontal: 'left' }}
      transformOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      slots={{ transition: Fade }}
      slotProps={{
        transition: { timeout: reduced ? 0 : 120 },
        paper: {
          sx: {
            width: Math.max(anchor?.offsetWidth ?? 0, MIN_WIDTH),
            borderRadius: '12px',
            bgcolor: 'background.paper',
            backgroundImage: 'none',
            border: '1px solid var(--mui-palette-divider)',
            boxShadow: 'var(--mui-shadows-8)',
            animation: reduced ? 'none' : `${rise} 120ms ease-out`,
          },
        },
      }}
    >
      <AccountMenu {...props} />
    </Popover>
  );
}
