'use client';

import type { ReactElement } from 'react';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { ReadinessItem } from '@contract/readiness';
import { NAMES, STATUS } from './readiness-panel';
import { useReadiness } from './use-readiness';

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function Details({ items }: { items: ReadinessItem[] }): ReactElement {
  const listed = items.filter((item) => item.status !== 'ok');
  return (
    <Box>
      {listed.map((item) => (
        <Typography key={item.id} variant="body2">
          {NAMES[item.id]}: {item.line}
        </Typography>
      ))}
    </Box>
  );
}

/** The compact header item: setup problems first, then setup warnings; else nothing. */
export function ReadinessStatus(): ReactElement | null {
  const { items } = useReadiness();
  const failing = items.filter((item) => item.status === 'fail').length;
  const warning = items.filter((item) => item.status === 'warn').length;
  let shown: { Icon: typeof STATUS.fail.Icon; color: string; text: string };
  if (failing > 0) {
    shown = {
      Icon: STATUS.fail.Icon,
      color: STATUS.fail.color,
      text: plural(failing, 'setup problem', 'setup problems'),
    };
  } else if (warning > 0) {
    shown = {
      Icon: STATUS.warn.Icon,
      color: STATUS.warn.color,
      text: plural(warning, 'setup warning', 'setup warnings'),
    };
  } else {
    return null;
  }
  return (
    <Tooltip title={<Details items={items} />} arrow disableInteractive>
      <Box
        component={Link}
        href="/#readiness"
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          mr: 2,
          color: 'inherit',
          textDecoration: 'none',
        }}
      >
        <shown.Icon fontSize="small" sx={{ color: shown.color }} />
        <Typography variant="body2" color="text.secondary">
          {shown.text}
        </Typography>
      </Box>
    </Tooltip>
  );
}
