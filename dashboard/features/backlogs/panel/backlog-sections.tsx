import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import type { BacklogChatView } from '@contract/backlog-chat';

interface BacklogSectionsProps {
  view: BacklogView;
  chat: BacklogChatView;
  login: string | null;
  onView: (view: BacklogView) => void;
  onChat: (chat: BacklogChatView) => void;
}

export function BacklogSections(_props: BacklogSectionsProps): ReactElement {
  return (
    <Box component="section" aria-label="Backlog" sx={{ minWidth: 0 }}>
      <Typography variant="subtitle1" component="h2">
        Backlog
      </Typography>
    </Box>
  );
}
