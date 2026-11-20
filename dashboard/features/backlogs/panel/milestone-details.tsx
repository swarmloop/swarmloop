import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import type { BacklogView } from '@contract/backlog';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { isLong } from '../../run';
import { BacklogTaskRow } from './backlog-task-row';
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
      <Box component="ul" sx={{ m: 0, p: 0 }}>
        {view.tasks
          .filter((task) => task.milestone === milestone.number)
          .map((task) => (
            <BacklogTaskRow key={task.slug} backlog={view.name} task={task} owner={owner} onView={onView} />
          ))}
      </Box>
    </Box>
  );
}
