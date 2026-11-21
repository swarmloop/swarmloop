'use client';

import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import { type Theme, ThemeProvider, createTheme } from '@mui/material/styles';
import Link from 'next/link';
import { DoneLately, NeedsYou, NowSection, OverviewFooter, OverviewNumbers } from '../features/overview';
import { ReadinessLine } from '../features/readiness';
import { useLiveBridge } from '../features/shell';
import { HOSTS } from './login/hosts';

/** The app bar (64 px) and the main area's vertical padding (24 px twice). */
const CHROME = '112px';

const BODY = '0.875rem';

/** The page reads in three sizes: the figure (40 px), body and caption, so the default text and the small buttons are body. */
const pageTheme = (outer: Theme): Theme =>
  createTheme(outer, {
    typography: { body1: { fontSize: BODY } },
    components: {
      MuiButton: { styleOverrides: { sizeSmall: { fontSize: BODY } } },
      MuiToggleButton: { styleOverrides: { sizeSmall: { fontSize: BODY } } },
    },
  });

export default function HomePage(): React.ReactElement {
  const loaded = useLiveBridge((snapshot) => snapshot.loaded);
  // The same counts as the run list's switch, so a subtask is never counted on its own.
  const all = useLiveBridge((snapshot) => snapshot.counts.all);
  const empty = loaded && all === 0;

  return (
    <ThemeProvider theme={pageTheme}>
      <Box
        sx={{
          display: 'flex',
          flexDirection: 'column',
          gap: 1.5,
          // The root grows with its content, so nothing is clipped or scrolls inside; short content fills the viewport.
          minHeight: `calc(100vh - ${CHROME})`,
          typography: 'body2',
        }}
      >
        <Typography variant="body2" component="h1" sx={{ fontWeight: 600 }}>
          Overview
        </Typography>
        <NeedsYou />
        <OverviewNumbers />
        <NowSection />
        {empty ? (
          <Box>
            <Typography variant="body2" color="text.secondary">
              No runs yet. New run, top right, starts one.
            </Typography>
            <Button component={Link} href="/connections" variant="outlined" size="small" sx={{ mt: 1 }}>
              {`Connect ${Object.values(HOSTS)
                .map((host) => host.label)
                .join(' or ')}`}
            </Button>
          </Box>
        ) : null}
        <DoneLately />
        <Box sx={{ mt: 'auto' }}>
          <OverviewFooter>
            <ReadinessLine />
          </OverviewFooter>
        </Box>
      </Box>
    </ThemeProvider>
  );
}
