import type { ReactElement } from 'react';
import ChevronRight from '@mui/icons-material/ChevronRight';

/** The one disclosure arrow: right when closed, turned 90° to point down when open. Decoration only. */
export function DisclosureIcon({ open = false }: { open?: boolean }): ReactElement {
  return (
    <ChevronRight
      fontSize="small"
      data-direction={open ? 'down' : 'right'}
      aria-hidden
      sx={(theme) => ({
        transform: open ? 'rotate(90deg)' : 'none',
        transition: theme.transitions.create('transform', { duration: theme.transitions.duration.shortest }),
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      })}
    />
  );
}
