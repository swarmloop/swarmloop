'use client';

import type { ReactElement } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import Box from '@mui/material/Box';

const Items = [
  { label: 'Runs', href: '/' },
  { label: 'Backlogs', href: '/backlogs' },
] as const;

/** Links between the main parts of the dashboard; the one for the current page is marked. */
export function MainNav(): ReactElement {
  const onBacklogs = /^\/backlogs(\/|$)/.test(usePathname());
  return (
    <Box component="nav" aria-label="Main" sx={{ display: 'flex', gap: 0.5, ml: 3 }}>
      {Items.map((item) => {
        const active = (item.href === '/backlogs') === onBacklogs;
        return (
          <Box
            key={item.href}
            component={Link}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            sx={{
              px: 1.5,
              py: 0.75,
              borderRadius: 1,
              textDecoration: 'none',
              color: active ? 'primary.main' : 'text.secondary',
              fontWeight: active ? 600 : 400,
              '&:hover': { bgcolor: 'action.hover' },
              '&:focus-visible': { outline: 2, outlineColor: 'primary.main', outlineOffset: 2 },
            }}
          >
            {item.label}
          </Box>
        );
      })}
    </Box>
  );
}
