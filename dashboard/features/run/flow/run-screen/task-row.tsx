import { useState, type ReactElement } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Collapse from '@mui/material/Collapse';
import IconButton from '@mui/material/IconButton';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import { alpha } from '@mui/material/styles';
import type { TaskEntry } from '@contract/api';
import { taskStateWord } from '@contract/run-state';
import type { RevisionMark } from '../../conversation/revision-marks';
import { DisclosureIcon } from '../../../../components/ui/disclosure-icon';
import { ConfirmDialog } from '../../../shell';
import { duration, localTime, money } from '../../../../lib/format';
import { RunStateIcon, toneColor } from '../../run-state-word';
import { TaskDetails } from './task-details';
import { taskNotes } from './task-notes';

/** The row's button: the plan before the task has a result, the changes after. */
function detailsLabel(task: TaskEntry): string {
  const result = task.run?.result;
  return result ? `Changes · ${result.files.length} ${result.files.length === 1 ? 'file' : 'files'}` : 'Plan';
}

/** One task on one line: its status, title, time and cost, with a short caption only when it waits or needs a person, and its plan and result on demand. `dependents` are the titles of the tasks that depend on it. */
export function TaskRow({
  task,
  dependents,
  onSkip,
  unmet = [],
  mark,
}: {
  task: TaskEntry;
  dependents: string[];
  /** The ids of the tasks it depends on that are not settled yet. */
  unmet?: string[];
  onSkip: (taskId: string) => Promise<unknown>;
  /** Set when the latest plan change added or changed this task. */
  mark?: RevisionMark | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const word = taskStateWord(task, localTime);
  const color = toneColor(word.tone);
  const step = task.status === 'running' && task.run ? ` · ${task.run.currentStep.replaceAll('-', ' ')}` : '';
  const hasDetails = task.files.length > 0 || task.proof !== '' || task.run?.result !== undefined;
  const { tip, caption } = taskNotes(task, word, unmet);
  const summary = (
    <>
      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color, flexShrink: 0 }}>
        <RunStateIcon view={{ ...word, tip }} size={16} />
        <Typography component="span" variant="caption" sx={{ color }}>
          {word.word}
          {step}
        </Typography>
      </Box>
      {mark ? (
        <Typography component="span" variant="caption" color="primary" sx={{ flexShrink: 0 }}>
          {mark === 'added' ? 'New in this plan' : 'Changed in this plan'}
        </Typography>
      ) : null}
      <Tooltip title={task.title}>
        <Typography variant="body2" noWrap sx={{ minWidth: 0, flex: '1 1 0' }}>
          {task.title}
        </Typography>
      </Tooltip>
      {task.run ? (
        <Typography component="span" variant="caption" color="text.secondary" sx={{ flexShrink: 0 }}>
          {duration(task.run.durationMs)} · {money(task.run.usd)}
        </Typography>
      ) : null}
    </>
  );
  const line = { display: 'flex', alignItems: 'center', gap: 1, flex: '1 1 0', minWidth: 0 };
  return (
    <Box
      component="li"
      sx={(theme) => ({
        listStyle: 'none',
        minWidth: 0,
        ...(mark ? { bgcolor: alpha(theme.palette.primary.main, 0.1), borderRadius: 1, px: 0.5 } : {}),
      })}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, minWidth: 0 }}>
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
          <Tooltip title={detailsLabel(task)}>
            <IconButton
              size="small"
              aria-label={detailsLabel(task)}
              aria-expanded={open}
              onClick={() => setOpen(!open)}
            >
              <DisclosureIcon open={open} />
            </IconButton>
          </Tooltip>
        ) : null}
      </Box>
      {caption !== '' || task.status === 'blocked' ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, pl: 3, minWidth: 0 }}>
          {caption !== '' ? (
            <Typography variant="caption" color="text.secondary">
              {caption}
            </Typography>
          ) : null}
          {task.status === 'blocked' ? (
            <Button size="small" onClick={() => setSkipping(true)}>
              Skip task
            </Button>
          ) : null}
        </Box>
      ) : null}
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
