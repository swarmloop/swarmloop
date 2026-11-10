'use client';

import type { ReactElement } from 'react';
import CheckCircle from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningAmber from '@mui/icons-material/WarningAmber';
import Alert from '@mui/material/Alert';
import Box from '@mui/material/Box';
import Paper from '@mui/material/Paper';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { ReadinessItem } from '@contract/api';
import { useReadiness } from './use-readiness';

const STATUS = {
  ok: { color: 'success.main', Icon: CheckCircle, word: 'ready' },
  warn: { color: 'warning.main', Icon: WarningAmber, word: 'warning' },
  fail: { color: 'error.main', Icon: ErrorIcon, word: 'problem' },
} as const satisfies Record<ReadinessItem['status'], { color: string; Icon: typeof CheckCircle; word: string }>;

const NAMES: Record<ReadinessItem['id'], string> = {
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

/** What a run needs, at a glance: one tile per check. An item that is not ok also says what to do. */
export function ReadinessPanel(): ReactElement | null {
  const { items, error } = useReadiness();
  if (error) {
    return <Alert severity="warning">Readiness is not available: {error}</Alert>;
  }
  if (items.length === 0) {
    return null;
  }
  const problems = items.filter((item) => item.status !== 'ok');
  const failing = problems.some((item) => item.status === 'fail');
  return (
    <Paper variant="outlined" component="section" aria-label="Readiness" sx={{ p: { xs: 2, md: 2.5 } }}>
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
      </Box>
      <Box
        component="ul"
        sx={{
          listStyle: 'none',
          m: 0,
          p: 0,
          display: 'grid',
          gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(4, minmax(0, 1fr))' },
          gap: 1,
        }}
      >
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
            </Alert>
          ))}
        </Box>
      ) : null}
    </Paper>
  );
}
