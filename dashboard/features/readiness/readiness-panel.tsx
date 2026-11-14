'use client';

import type { ReactElement } from 'react';
import { useEffect, useState } from 'react';
import CheckCircle from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningAmber from '@mui/icons-material/WarningAmber';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Link from '@mui/material/Link';
import Paper from '@mui/material/Paper';
import Skeleton from '@mui/material/Skeleton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { ReadinessItem } from '@contract/readiness';
import { useReadiness } from './use-readiness';

export const STATUS = {
  ok: { color: 'success.main', Icon: CheckCircle, word: 'ready' },
  warn: { color: 'warning.main', Icon: WarningAmber, word: 'warning' },
  fail: { color: 'error.main', Icon: ErrorIcon, word: 'problem' },
} as const satisfies Record<ReadinessItem['status'], { color: string; Icon: typeof CheckCircle; word: string }>;

export const NAMES: Record<ReadinessItem['id'], string> = {
  docker: 'Docker',
  arch: 'Platform',
  images: 'Images',
  disk: 'Disk',
  paths: 'Folders',
  ports: 'Ports',
  'model-credential': 'Model key',
  'code-host-token': 'Git token',
};

/** The few words an ok item shows; its whole line is in the tooltip. */
export function shortLine(item: ReadinessItem): string {
  const line = item.line;
  switch (item.id) {
    case 'docker':
      return 'running';
    case 'arch':
      return line.split(' ')[0] ?? line;
    case 'images':
      return `${(line.match(/is present/g) ?? []).length} present`;
    case 'paths':
      return 'writable';
    case 'ports':
      return (line.match(/\b\d{2,5}\b/g) ?? []).join(' · ') || line;
    case 'model-credential':
      return line.match(/for (\S+)/)?.[1] ?? 'set';
    case 'code-host-token':
      return line.match(/^(\w+?)_TOKEN/)?.[1]?.toLowerCase() ?? 'accepted';
    case 'disk':
      return line.split(/[;,(]/)[0].trim();
  }
}

/** The `name size` parts of what swarmloop itself uses, from the Disk line. Empty for any other line. */
function ownUse(item: ReadinessItem): string {
  return item.id === 'disk' ? (item.line.match(/swarmloop uses (.*)$/)?.[1] ?? '') : '';
}

/** The age of a report in words: `30 s`, `4 min` or `2 h`. */
function ageWords(checkedAt: string, now: number): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(checkedAt)) / 1000));
  if (seconds < 60) {
    return `${seconds} s`;
  }
  return seconds < 3600 ? `${Math.floor(seconds / 60)} min` : `${Math.floor(seconds / 3600)} h`;
}

/** The current time, re-read every second so an age on screen keeps counting. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

const GRID_SX = {
  listStyle: 'none',
  m: 0,
  p: 0,
  display: 'grid',
  gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
  gap: 1,
} as const;

function PanelLoading(): ReactElement {
  return (
    <Paper variant="outlined" component="section" id="readiness" aria-label="Readiness" sx={{ p: { xs: 2, md: 2.5 } }}>
      <Typography sx={{ fontWeight: 600, mb: 1.5 }}>Checking readiness</Typography>
      <Box component="ul" sx={GRID_SX}>
        {(Object.keys(NAMES) as ReadinessItem['id'][]).map((id) => (
          <Box component="li" key={id} data-testid="readiness-placeholder">
            <Skeleton variant="rounded" height={56} />
          </Box>
        ))}
      </Box>
    </Paper>
  );
}

/** What a run needs, at a glance: one tile per check. An item that is not ok also says what to do. */
export function ReadinessPanel(): ReactElement {
  const { items, error, loading, refreshFailed, checkedAt } = useReadiness();
  const now = useNow();
  if (error) {
    return (
      <Alert id="readiness" severity="warning">
        Readiness is not available: {error}
      </Alert>
    );
  }
  if (loading) {
    return <PanelLoading />;
  }
  const problems = items.filter((item) => item.status !== 'ok');
  const failing = problems.some((item) => item.status === 'fail');
  return (
    <Paper variant="outlined" component="section" id="readiness" aria-label="Readiness" sx={{ p: { xs: 2, md: 2.5 } }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5 }}>
        <Box
          component="span"
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: failing ? 'error.main' : problems.length > 0 ? 'warning.main' : 'success.main',
          }}
        />
        <Typography sx={{ fontWeight: 600 }}>
          {failing ? 'A run cannot start yet' : problems.length > 0 ? 'Ready, with warnings' : 'Ready to run'}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {items.length - problems.length} of {items.length} checks pass
        </Typography>
        {checkedAt ? (
          <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
            checked {ageWords(checkedAt, now)} ago
          </Typography>
        ) : null}
        {refreshFailed ? (
          <Typography variant="caption" color="text.secondary" sx={checkedAt ? undefined : { ml: 'auto' }}>
            could not refresh, retrying
          </Typography>
        ) : null}
      </Box>
      <Box component="ul" sx={GRID_SX}>
        {items.map((item) => {
          const { color, Icon, word } = STATUS[item.status];
          return (
            <Tooltip key={item.id} title={item.line} placement="top" arrow disableInteractive>
              <Box
                component="li"
                tabIndex={0}
                aria-label={`${NAMES[item.id]}: ${word}, ${item.line}`}
                sx={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  px: 1.25,
                  py: 1,
                  borderRadius: 1.5,
                  bgcolor: 'action.hover',
                  minWidth: 0,
                  outline: 'none',
                  '&:focus-visible': { boxShadow: (theme) => `0 0 0 2px ${theme.palette.primary.main}` },
                }}
              >
                <Icon sx={{ fontSize: 18, color, flexShrink: 0 }} />
                <Box sx={{ minWidth: 0 }}>
                  <Typography sx={{ fontSize: 13, fontWeight: 600, lineHeight: 1.3 }} noWrap>
                    {NAMES[item.id]}
                  </Typography>
                  <Typography sx={{ fontSize: 12, color: 'text.secondary', lineHeight: 1.3 }} noWrap>
                    {item.status === 'ok' ? shortLine(item) : word}
                  </Typography>
                  {ownUse(item) ? (
                    <Typography sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.3 }}>
                      {ownUse(item)}
                    </Typography>
                  ) : null}
                </Box>
              </Box>
            </Tooltip>
          );
        })}
      </Box>
      {problems.length > 0 ? (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 1.5 }}>
          {problems.map((item) => (
            <Alert key={item.id} severity={item.status === 'fail' ? 'error' : 'warning'} sx={{ py: 0 }}>
              <strong>{NAMES[item.id]}</strong>: {item.line} — {item.action}
              {item.link ? (
                <>
                  {' '}
                  <Link href={item.link}>Open Connections</Link>
                </>
              ) : null}
            </Alert>
          ))}
        </Box>
      ) : null}
    </Paper>
  );
}
