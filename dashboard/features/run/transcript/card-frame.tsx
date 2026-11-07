import { type ReactElement, type ReactNode, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { Side } from './transcript-model';

/**
 * The box every card sits in: inputs hug the right edge, actions the left. It never grows wider than the feed.
 * `children` is the main line, a sentence. `meta` is the small footer, where ids go. `detail` stays closed until asked for.
 */
export function CardFrame({
  side,
  label,
  children,
  meta,
  detail,
  detailLabel = 'details',
}: {
  side: Side;
  label: string;
  children: ReactNode;
  meta?: ReactNode;
  detail?: ReactNode;
  detailLabel?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Box
      sx={{
        alignSelf: side === 'right' ? 'flex-end' : 'flex-start',
        minWidth: 0,
        maxWidth: '85%',
        border: 1,
        borderColor: 'divider',
        borderRadius: 1,
        px: 1.25,
        py: 0.75,
        overflowWrap: 'anywhere',
      }}
    >
      <Typography variant="overline" color="text.secondary">
        {label}
      </Typography>
      <Box data-testid="card-main" sx={{ fontSize: 13, minWidth: 0 }}>
        {children}
      </Box>
      {meta ? (
        <Typography data-testid="card-meta" variant="caption" color="text.secondary" component="div">
          {meta}
        </Typography>
      ) : null}
      {detail ? (
        <>
          <Button size="small" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            {open ? `Hide ${detailLabel}` : `Show ${detailLabel}`}
          </Button>
          {open ? <Box sx={{ minWidth: 0 }}>{detail}</Box> : null}
        </>
      ) : null}
    </Box>
  );
}
