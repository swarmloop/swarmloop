import type { ReactElement } from 'react';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import Box from '@mui/material/Box';
import type { CheckCommandView } from '@contract/api';
import { statusColor } from '../../../theme/theme';
import { commandCounts } from '../check-commands';

/** How far the checks are: a thin bar split into passed, failed, running and queued, and `passed/total` or `N failed`. */
export function ChecksProgress({ commands }: { commands: CheckCommandView[] }): ReactElement {
  const counts = commandCounts(commands);
  const parts = [
    { key: 'passed', count: counts.passed, color: statusColor('done') },
    { key: 'failed', count: counts.failed, color: statusColor('failed') },
    { key: 'running', count: counts.running, color: statusColor('running') },
    { key: 'queued', count: counts.queued, color: 'divider' },
  ];
  return (
    <Box sx={{ flexBasis: '100%', display: 'grid', gap: 0.5 }}>
      <Box sx={{ display: 'flex', height: 4, borderRadius: 2, overflow: 'hidden' }} aria-hidden>
        {parts.map((part) => (
          <Box key={part.key} data-part={part.key} sx={{ flex: part.count, bgcolor: part.color }} />
        ))}
      </Box>
      {counts.failed > 0 ? (
        <Box
          component="span"
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 0.5,
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            color: statusColor('failed'),
          }}
        >
          <ErrorOutline sx={{ fontSize: 14 }} />
          {counts.failed} failed
        </Box>
      ) : (
        <Box component="span" sx={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'text.secondary' }}>
          {counts.passed}/{counts.total}
        </Box>
      )}
    </Box>
  );
}
