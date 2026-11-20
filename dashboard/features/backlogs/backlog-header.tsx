import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';

interface BacklogHeaderProps {
  view: BacklogView;
  login: string | null;
  onView: (view: BacklogView) => void;
}

export function BacklogHeader({ view }: BacklogHeaderProps): ReactElement {
  return (
    <Box component="section" aria-label="Backlog header" sx={{ minHeight: 56, display: 'flex', alignItems: 'center' }}>
      <Typography variant="h5" component="h1">
        {view.name}
      </Typography>
    </Box>
  );
}
