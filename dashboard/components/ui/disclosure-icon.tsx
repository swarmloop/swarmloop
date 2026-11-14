import type { ReactElement } from 'react';
import ChevronRight from '@mui/icons-material/ChevronRight';
import ExpandMore from '@mui/icons-material/ExpandMore';

/** The one disclosure arrow: right when closed, down when open. A plain arrow, no filled circle. */
export function DisclosureIcon({ open }: { open: boolean }): ReactElement {
  const Arrow = open ? ExpandMore : ChevronRight;
  return <Arrow fontSize="small" data-direction={open ? 'down' : 'right'} aria-hidden />;
}
