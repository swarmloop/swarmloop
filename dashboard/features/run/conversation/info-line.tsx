'use client';

import { type ReactElement, type ReactNode, useState } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import ButtonBase from '@mui/material/ButtonBase';
import Box from '@mui/material/Box';
import MuiLink from '@mui/material/Link';
import Typography from '@mui/material/Typography';

/** One muted sentence. With `detail` it is a button that opens the whole text in place. */
export function InfoLine({
  sentence,
  detail,
  label = 'Show details',
  link,
  action,
}: {
  sentence: string;
  detail?: ReactNode;
  /** What the screen reader says of the button that opens the detail. */
  label?: string;
  /** A page the sentence is about, shown after it. */
  link?: { href: Route; text: string };
  /** An in-page step the sentence leads to, shown after it as a button. */
  action?: { text: string; onClick: () => void };
}): ReactElement {
  const [open, setOpen] = useState(false);
  const go = action ? (
    <Typography variant="caption" sx={{ ml: 0.5 }}>
      <MuiLink component="button" type="button" onClick={action.onClick}>
        {action.text}
      </MuiLink>
    </Typography>
  ) : null;
  const line = (
    <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere', textAlign: 'left' }}>
      {sentence}
    </Typography>
  );
  if (!detail) {
    return (
      <Box sx={{ px: 1 }}>
        {line}
        {link ? (
          <Typography variant="caption" sx={{ ml: 0.5 }}>
            <Link href={link.href}>{link.text}</Link>
          </Typography>
        ) : null}
        {go}
      </Box>
    );
  }
  return (
    <Box sx={{ px: 1 }}>
      <ButtonBase
        aria-expanded={open}
        aria-label={`${label}: ${sentence}`}
        onClick={() => setOpen((value) => !value)}
        sx={{ display: 'block', width: '100%', borderRadius: 1, textAlign: 'left' }}
      >
        {line}
      </ButtonBase>
      {go}
      {open ? (
        <Box sx={{ mt: 0.5, pl: 1, borderLeft: 2, borderColor: 'divider', overflowWrap: 'anywhere' }}>{detail}</Box>
      ) : null}
    </Box>
  );
}
