import { useState, type ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import type { BacklogChatView } from '@contract/backlog-chat';
import { milestoneWork } from '@contract/milestone-work';
import { acceptMilestone } from '../../../lib/backlog-endpoints';
import { ConfirmDialog } from '../../shell';
import { MilestoneDetails } from './milestone-details';

interface MilestonePanelProps {
  view: BacklogView;
  chat: BacklogChatView;
  login: string | null;
  onView: (view: BacklogView) => void;
  onChat: (chat: BacklogChatView) => void;
}

export function MilestonePanel({ view, login, onView }: MilestonePanelProps): ReactElement {
  const [accepting, setAccepting] = useState(false);
  const active = view.milestones.find((item) => item.status === 'active');
  const owner = login !== null && login === view.owner;
  return (
    <Box component="section" aria-label="Milestone" sx={{ minWidth: 0 }}>
      <Typography variant="subtitle1" component="h2">
        {active ? `M${active.number} · ${active.title}` : 'Milestone'}
      </Typography>
      {active ? (
        <>
          {owner ? (
            <Box sx={{ my: 0.5 }}>
              <Button
                size="small"
                variant="outlined"
                disabled={!milestoneWork(view, active.number).done}
                onClick={() => setAccepting(true)}
              >
                Accept milestone
              </Button>
              <ConfirmDialog
                open={accepting}
                title={`Accept M${active.number}?`}
                body="The milestone closes and the next queued one starts. This cannot be undone."
                verb="Accept milestone"
                tone="primary"
                onConfirm={async () => onView(await acceptMilestone(view.name, active.number))}
                onClose={() => setAccepting(false)}
              />
            </Box>
          ) : null}
          <MilestoneDetails view={view} milestone={active} owner={owner} onView={onView} />
        </>
      ) : (
        <Typography variant="body2" color="text.secondary">
          No milestone is active.
        </Typography>
      )}
    </Box>
  );
}
