import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { isLong } from '../../run';
import { BacklogTaskRow } from './backlog-task-row';
import { AddTaskButton } from './task-editor';
import { useTaskDrop } from './use-task-drop';
import { RequirementList } from './requirement-list';

type Milestone = BacklogView['milestones'][number];

/** One milestone's goal, requirements and tasks. */
export function MilestoneDetails({
  view,
  milestone,
  owner,
  onView,
}: {
  view: BacklogView;
  milestone: Milestone;
  owner: boolean;
  onView: (view: BacklogView) => void;
}): ReactElement {
  const drop = useTaskDrop(view.name, milestone.number, onView);
  const goal = <MarkdownBody text={milestone.goal} />;
  return (
    <Box sx={{ display: 'grid', gap: 1, minWidth: 0 }}>
      {isLong(milestone.goal) ? (
        <Box component="details">
          <Box component="summary" sx={{ cursor: 'pointer', fontSize: 14 }}>
            Show the whole goal
          </Box>
          {goal}
        </Box>
      ) : (
        goal
      )}
      <RequirementList
        requirements={view.requirements.filter((item) => item.milestone === milestone.number)}
        tasks={view.tasks}
      />
      <Box component="ul" {...drop.target} sx={{ m: 0, p: 0, minHeight: 24 }}>
        {view.tasks
          .filter((task) => task.milestone === milestone.number)
          .map((task) => (
            <BacklogTaskRow key={task.slug} view={view} task={task} owner={owner} onView={onView} />
          ))}
      </Box>
      {drop.refusal !== '' ? (
        <Typography role="alert" variant="caption" color="error">
          {drop.refusal}
        </Typography>
      ) : null}
      <Box>
        <AddTaskButton view={view} milestone={milestone.number} onView={onView} />
      </Box>
    </Box>
  );
}
