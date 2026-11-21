import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';

type Requirement = BacklogView['requirements'][number];
type Task = BacklogView['tasks'][number];

const MARK_COLOR = { open: 'text.secondary', ready: 'warning.main', closed: 'success.main' } as const;

function closedBy(requirement: Requirement, tasks: Task[]): string {
  const titles = requirement.closedBy.flatMap((slug) => tasks.find((task) => task.slug === slug)?.title ?? []);
  return titles.length > 0 ? `closed by ${titles.join(', ')}` : 'closed by hand';
}

/** The numbered requirements with their marks in words, and what closed each. */
export function RequirementList({ requirements, tasks }: { requirements: Requirement[]; tasks: Task[] }): ReactElement {
  return (
    <Box component="ol" sx={{ m: 0, pl: 3, minWidth: 0 }}>
      {requirements.map((requirement) => (
        <Box component="li" key={requirement.ref} sx={{ py: 0.25 }}>
          <Typography variant="body2" component="span">
            {requirement.text}
          </Typography>{' '}
          <Typography variant="caption" component="span" sx={{ color: MARK_COLOR[requirement.status] }}>
            {requirement.status}
            {requirement.status === 'closed' ? ` · ${closedBy(requirement, tasks)}` : ''}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
