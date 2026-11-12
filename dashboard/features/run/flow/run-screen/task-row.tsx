import { useState, type ReactElement } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Typography from '@mui/material/Typography';
import type { TaskLayer } from '@contract/api';
import { duration, money } from '../../../../lib/format';
import { TaskDetails } from './task-details';
import { TASK_STATUS } from './task-status';

type Task = TaskLayer['tasks'][number];

/** One task on one line: its status, title, dependencies, time and cost, with its files and proof on demand. */
export function TaskRow({ task, onSkip }: { task: Task; onSkip: (taskId: string) => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const { Icon, color, word } = TASK_STATUS[task.status];
  const step = task.status === 'running' && task.run ? ` · ${task.run.currentStep.replaceAll('-', ' ')}` : '';
  const hasDetails = task.files.length > 0 || task.proof !== '';
  const count = `${task.files.length} ${task.files.length === 1 ? 'file' : 'files'} · proof`;
  const summary = (
    <>
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color, flexShrink: 0 }}>
        <Icon sx={{ fontSize: 16 }} />
        <Typography component="span" variant="caption" sx={{ color }}>
          {word}
          {step}
        </Typography>
      </Box>
      <Typography variant="body2" noWrap sx={{ minWidth: 0, flex: '1 1 8rem' }}>
        {task.title}
      </Typography>
      {task.depends.length > 0 ? (
        <Typography component="span" variant="caption" color="text.secondary">
          after {task.depends.join(', ')}
        </Typography>
      ) : null}
      {task.note ? (
        <Typography component="span" variant="caption" color="text.secondary">
          {task.note}
        </Typography>
      ) : null}
      {task.run ? (
        <Typography
          component="span"
          variant="caption"
          color="text.secondary"
          sx={{ flexBasis: { xs: '100%', sm: 'auto' }, pl: { xs: 3, sm: 0 } }}
        >
          {duration(task.run.durationMs)} · {money(task.run.usd)}
        </Typography>
      ) : null}
    </>
  );
  const line = { display: 'flex', alignItems: 'center', gap: 1, flex: '1 1 0', minWidth: 0, flexWrap: 'wrap' };
  return (
    <Box component="li" sx={{ listStyle: 'none', minWidth: 0 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
        {task.run ? (
          <Box
            component={Link}
            href={`/runs/${task.run.key}` as Route}
            aria-label={`Open run ${task.title}`}
            sx={{
              ...line,
              color: 'inherit',
              textDecoration: 'none',
              '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
            }}
          >
            {summary}
          </Box>
        ) : (
          <Box sx={line}>{summary}</Box>
        )}
        {hasDetails ? (
          <Button size="small" aria-expanded={open} onClick={() => setOpen(!open)}>
            {count}
          </Button>
        ) : null}
        {task.status === 'blocked' ? (
          <Button size="small" onClick={() => onSkip(task.id)}>
            Skip task
          </Button>
        ) : null}
      </Box>
      <Collapse in={open} unmountOnExit>
        <TaskDetails files={task.files} proof={task.proof} />
      </Collapse>
    </Box>
  );
}
