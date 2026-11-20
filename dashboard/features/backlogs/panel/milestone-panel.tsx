import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import type { BacklogChatView } from '@contract/backlog-chat';

interface MilestonePanelProps {
  view: BacklogView;
  chat: BacklogChatView;
  login: string | null;
  onView: (view: BacklogView) => void;
  onChat: (chat: BacklogChatView) => void;
}

export function MilestonePanel(_props: MilestonePanelProps): ReactElement {
  return (
    <Box component="section" aria-label="Milestone" sx={{ minWidth: 0 }}>
      <Typography variant="subtitle1" component="h2">
        Milestone
      </Typography>
    </Box>
  );
}
