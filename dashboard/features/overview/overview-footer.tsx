import type { ReactElement, ReactNode } from 'react';
import Link from 'next/link';
import type { Route } from 'next';
import Box from '@mui/material/Box';

const LINKS: { label: string; href: Route }[] = [
  { label: 'Stats', href: '/stats' },
  { label: 'Runs', href: '/' },
  { label: 'Backlogs', href: '/backlogs' },
  { label: 'Settings', href: '/settings' },
  { label: 'Connections', href: '/connections' },
];

/** Links to the other pages and the readiness slot it is given. */
export function OverviewFooter({ children }: { children: ReactNode }): ReactElement {
  return (
    <Box
      component="footer"
      sx={{
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        typography: 'caption',
        // The readiness panel sets its own sizes; here its text reads at the page's body size.
        '& .MuiTypography-body1': { fontSize: '0.875rem' },
      }}
    >
      <Box component="nav" aria-label="Pages" sx={{ display: 'flex', flexWrap: 'wrap', gap: 2 }}>
        {LINKS.map((link) => (
          <Link key={link.href} href={link.href}>
            {link.label}
          </Link>
        ))}
      </Box>
      {children}
    </Box>
  );
}
