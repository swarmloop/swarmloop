import { useState, type ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { DecisionView, TaskEntry } from '@contract/api';
import { epicFigures } from '@contract/epic-figures';
import { needsPerson } from '@contract/run-state';
import { unmetDepends } from '@contract/subtask';
import { orderTasks, taskGroup } from '@contract/task-order';
import type { PlanRevision } from '@contract/plan-chat';
import { markOf } from '../../conversation/revision-marks';
import { duration, money } from '../../../../lib/format';
import { TaskDecisions } from './task-decisions';
import { TaskRow } from './task-row';

/** The titles of the tasks that depend on `task`. */
function dependentsOf(task: TaskEntry, tasks: TaskEntry[]): string[] {
  return tasks.filter((other) => other.depends.includes(task.id)).map((other) => other.title);
}

/** `4 tasks, all merged`, or how many are merged and skipped. */
function tasksLine(total: number, merged: number, skipped: number): string {
  const done = skipped === 0 && merged === total && total > 0 ? 'all merged' : `${merged} merged`;
  return `${total} tasks, ${done}${skipped > 0 ? `, ${skipped} skipped` : ''}`;
}

/** The tasks of a split plan: the open ones in the shared task order, the merged and skipped ones folded into one line, then the merge queue and the decisions. `epic` is set once a task has started, with the parent's own cost in `ownUsd`. */
export function TaskLayers({
  tasks: planned,
  now,
  epic,
  ownUsd = 0,
  mergeQueue,
  decisions,
  onSkip,
  revision = null,
}: {
  tasks: TaskEntry[];
  now: number;
  epic?: { usd: number; durationMs: number };
  ownUsd?: number;
  mergeQueue?: { id: string; title: string }[];
  decisions?: DecisionView[];
  onSkip: (taskId: string) => Promise<unknown>;
  /** The latest plan change: the tasks it added or changed are marked. */
  revision?: PlanRevision | null;
}): ReactElement {
  const [settledOpen, setSettledOpen] = useState(false);
  const tasks = [...planned].sort((a, b) => a.index - b.index);
  const { open, settled } = orderTasks(tasks, (task) =>
    taskGroup(task.status, task.run !== undefined && needsPerson(task.run.state, task.run.stateReason)),
  );
  const skipped = settled.filter((task) => task.status === 'skipped').length;
  const merged = settled.length - skipped;
  const started = tasks.flatMap((task) => (task.run ? [task.run] : []));
  const figures = epic
    ? epicFigures(
        {
          epicUsd: epic.usd,
          ownUsd,
          epicMs: epic.durationMs,
          taskCount: tasks.length,
          workedMs: started.length > 0 ? started.reduce((sum, run) => sum + run.durationMs, 0) : null,
        },
        { money, duration },
      )
    : null;
  const summary = [tasksLine(tasks.length, merged, skipped), ...(figures ? [figures.tasksMoney] : [])].join(' · ');
  const row = (task: TaskEntry): ReactElement => (
    <TaskRow
      key={`${task.title} ${task.proof}`}
      task={task}
      now={now}
      dependents={dependentsOf(task, tasks)}
      unmet={unmetDepends(task, tasks)}
      onSkip={onSkip}
      mark={markOf(revision, task.title)}
    />
  );
  return (
    <Box component="section" aria-label="Tasks" sx={{ my: 2, display: 'grid', gap: 1, minWidth: 0 }}>
      <Typography variant="subtitle2">Tasks</Typography>
      <Tooltip title={figures?.workedTip ?? ''}>
        <Box sx={{ justifySelf: 'start' }}>
          {settled.length > 0 ? (
            <Button
              size="small"
              color="inherit"
              aria-expanded={settledOpen}
              onClick={() => setSettledOpen(!settledOpen)}
              sx={{ p: 0, minWidth: 0, textTransform: 'none', fontWeight: 400 }}
            >
              {summary}
            </Button>
          ) : (
            <Typography variant="body2">{summary}</Typography>
          )}
        </Box>
      </Tooltip>
      <LinearProgress
        variant="determinate"
        value={tasks.length > 0 ? (merged / tasks.length) * 100 : 0}
        aria-label="Merged"
        sx={{ height: 4, borderRadius: 2 }}
      />
      <Box component="ul" sx={{ m: 0, p: 0, display: 'grid', gap: 0.5 }}>
        {open.map(row)}
      </Box>
      {settledOpen ? (
        <Box component="ul" sx={{ m: 0, p: 0, display: 'grid', gap: 0.5 }}>
          {settled.map(row)}
        </Box>
      ) : null}
      {mergeQueue?.length ? (
        <Box component="section" aria-label="Merge queue">
          <Typography variant="caption" color="text.secondary">
            Merge queue
          </Typography>
          {mergeQueue.map((task) => (
            <Typography key={task.title} variant="body2" sx={{ pl: 1 }}>
              {task.title}
            </Typography>
          ))}
        </Box>
      ) : null}
      {decisions ? <TaskDecisions decisions={decisions} /> : null}
    </Box>
  );
}
