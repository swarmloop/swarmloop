import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import type { BacklogChatView } from '@contract/backlog-chat';
import { MilestoneDetails } from './milestone-details';

interface MilestonePanelProps {
  view: BacklogView;
  chat: BacklogChatView;
  login: string | null;
  onView: (view: BacklogView) => void;
  onChat: (chat: BacklogChatView) => void;
}

export function MilestonePanel({ view, login, onView }: MilestonePanelProps): ReactElement {
  const active = view.milestones.find((item) => item.status === 'active');
  return (
    <Box component="section" aria-label="Milestone" sx={{ minWidth: 0 }}>
      <Typography variant="subtitle1" component="h2">
        {active ? `M${active.number} · ${active.title}` : 'Milestone'}
      </Typography>
      {active ? (
        <MilestoneDetails
          view={view}
          milestone={active}
          owner={login !== null && login === view.owner}
          onView={onView}
        />
      ) : (
        <Typography variant="body2" color="text.secondary">
          No milestone is active.
        </Typography>
      )}
    </Box>
  );
}
