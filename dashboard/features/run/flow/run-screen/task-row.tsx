import { useState, type ReactElement } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import type { TaskEntry } from '@contract/api';
import { interruptionSentence } from '@contract/interruption';
import type { RevisionMark } from '../../conversation/revision-marks';
import { ConfirmDialog } from '../../../shell';
import { duration, localTime, money } from '../../../../lib/format';
import { TaskDetails } from './task-details';
import { TASK_STATUS } from './task-status';

/** The row's button: the plan before the task has a result, the changes after. */
function detailsLabel(task: TaskEntry): string {
  const result = task.run?.result;
  return result ? `Changes · ${result.files.length} ${result.files.length === 1 ? 'file' : 'files'}` : 'Plan';
}

/** One task on one line: its status, title, what it waits for, time and cost, with its plan and result on demand. `dependents` are the titles of the tasks that depend on it. */
export function TaskRow({
  task,
  dependents,
  onSkip,
  mark,
}: {
  task: TaskEntry;
  dependents: string[];
  onSkip: (taskId: string) => Promise<unknown>;
  /** Set when the latest plan change added or changed this task. */
  mark?: RevisionMark | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const { Icon, color, word } = TASK_STATUS[task.status];
  const step = task.status === 'running' && task.run ? ` · ${task.run.currentStep.replaceAll('-', ' ')}` : '';
  const hasDetails = task.files.length > 0 || task.proof !== '' || task.run?.result !== undefined;
  const summary = (
    <>
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color, flexShrink: 0 }}>
        <Icon sx={{ fontSize: 16 }} />
        <Typography component="span" variant="caption" sx={{ color }}>
          {word}
          {step}
        </Typography>
      </Box>
      {mark ? (
        <Typography component="span" variant="caption" color="primary">
          {mark === 'added' ? 'New in this plan' : 'Changed in this plan'}
        </Typography>
      ) : null}
      <Tooltip title={task.title}>
        <Typography variant="body2" noWrap sx={{ minWidth: 0, flex: '1 1 8rem' }}>
          {task.title}
        </Typography>
      </Tooltip>
      {task.waitsFor ? (
        <Typography component="span" variant="caption" color="text.secondary">
          {task.waitsFor.length > 0 ? `waiting for ${task.waitsFor.join(', ')}` : 'waiting for a free slot'}
        </Typography>
      ) : null}
      {task.depends.length > 0 ? (
        <Typography component="span" variant="caption" color="text.secondary">
          after {task.depends.join(', ')}
        </Typography>
      ) : null}
      {task.note && !task.waitsFor ? (
        <Typography component="span" variant="caption" color="text.secondary">
          {task.note}
        </Typography>
      ) : null}
      {task.run?.interruption ? (
        <Typography component="span" variant="caption" color="text.secondary">
          {interruptionSentence(task.run.interruption, localTime)}
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
    <Box
      component="li"
      sx={(theme) => ({
        listStyle: 'none',
        minWidth: 0,
        ...(mark ? { bgcolor: alpha(theme.palette.primary.main, 0.1), borderRadius: 1, px: 0.5 } : {}),
      })}
    >
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
            {detailsLabel(task)}
          </Button>
        ) : null}
        {task.status === 'blocked' ? (
          <Button size="small" onClick={() => setSkipping(true)}>
            Skip task
          </Button>
        ) : null}
      </Box>
      <ConfirmDialog
        open={skipping}
        title={`Skip task ${task.id}?`}
        body={`Its subtask run stops and its work is not merged. ${
          dependents.length > 0
            ? `${dependents.join(', ')} go on as if it were merged.`
            : 'No other task depends on it.'
        } The epic's final review checks the whole result.`}
        verb="Skip task"
        tone="danger"
        onConfirm={() => onSkip(task.id)}
        onClose={() => setSkipping(false)}
      />
      <Collapse in={open} unmountOnExit>
        <TaskDetails files={task.files} proof={task.proof} result={task.run?.result} />
      </Collapse>
    </Box>
  );
}
