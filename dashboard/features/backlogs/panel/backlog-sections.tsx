import { useState, type ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import type { BacklogChatView } from '@contract/backlog-chat';
import { runBacklog, runMilestone } from '../../../lib/backlog-endpoints';
import { localTime } from '../../../lib/format';
import { BacklogTaskRow } from './backlog-task-row';
import { FoldedSection } from './folded-section';
import { AddTaskButton } from './task-editor';
import { useTaskDrop } from './use-task-drop';
import { MilestoneDetails } from './milestone-details';

interface BacklogSectionsProps {
  view: BacklogView;
  chat: BacklogChatView;
  login: string | null;
  onView: (view: BacklogView) => void;
  onChat: (chat: BacklogChatView) => void;
}

export function BacklogSections({ view, login, onView }: BacklogSectionsProps): ReactElement {
  const [refusal, setRefusal] = useState('');
  const [busy, setBusy] = useState(false);
  const owner = login !== null && login === view.owner;
  const planned = view.milestones.filter((item) => item.status === 'proposed' || item.status === 'queued');
  const drop = useTaskDrop(view.name, null, onView);
  const items = view.tasks.filter((task) => task.milestone === null);
  const start = async (call: () => Promise<BacklogView>): Promise<void> => {
    setBusy(true);
    setRefusal('');
    try {
      onView(await call());
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : 'The start was refused.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Box component="section" aria-label="Backlog" sx={{ minWidth: 0, display: 'grid', gap: 1 }}>
      {owner && planned.some((item) => item.status === 'proposed') ? (
        <Box>
          <Button
            variant="contained"
            size="small"
            disabled={busy}
            onClick={() => void start(() => runBacklog(view.name))}
          >
            Run backlog
          </Button>
        </Box>
      ) : null}
      {refusal !== '' ? (
        <Typography role="alert" variant="caption" color="error">
          {refusal}
        </Typography>
      ) : null}
      <FoldedSection title="Planned milestones" count={planned.length}>
        {planned.map((item) => (
          <FoldedSection
            key={item.number}
            title={`M${item.number} · ${item.title}`}
            action={
              owner && item.status === 'proposed' ? (
                <Button
                  size="small"
                  variant="outlined"
                  disabled={busy}
                  onClick={() => void start(() => runMilestone(view.name, item.number))}
                >
                  Run milestone
                </Button>
              ) : null
            }
          >
            <MilestoneDetails view={view} milestone={item} owner={owner} onView={onView} />
          </FoldedSection>
        ))}
      </FoldedSection>
      <FoldedSection title="Backlog items" count={items.length}>
        <Box component="ul" {...drop.target} sx={{ m: 0, p: 0, minHeight: 24 }}>
          {items.map((task) => (
            <BacklogTaskRow key={task.slug} view={view} task={task} owner={owner} onView={onView} />
          ))}
        </Box>
        {drop.refusal !== '' ? (
          <Typography role="alert" variant="caption" color="error">
            {drop.refusal}
          </Typography>
        ) : null}
        <AddTaskButton view={view} milestone={null} onView={onView} />
      </FoldedSection>
      <FoldedSection title="Decisions" count={view.decisions.length}>
        <Box component="ul" sx={{ m: 0, p: 0 }}>
          {view.decisions.map((decision, index) => (
            <Box component="li" key={`${decision.at}-${index}`} sx={{ listStyle: 'none', py: 0.5 }}>
              <Typography variant="body2">{decision.text}</Typography>
              <Typography variant="caption" color="text.secondary">
                {decision.who} · {localTime(decision.at)}
              </Typography>
            </Box>
          ))}
        </Box>
      </FoldedSection>
    </Box>
  );
}
