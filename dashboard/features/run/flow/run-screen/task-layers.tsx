import { useState, type ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { TaskEntry } from '@contract/api';
import { epicFigures } from '@contract/epic-figures';
import { needsPerson } from '@contract/run-state';
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

/** The tasks of a split plan: the open ones in the shared task order, the merged and skipped ones folded into one line, then the merge queue and the decisions. `epic` is set once a task has started, with the parent's own cost in `ownUsd`. */
export function TaskLayers({
  tasks: planned,
  epic,
  ownUsd = 0,
  mergeQueue,
  decisions,
  onSkip,
  revision = null,
}: {
  tasks: TaskEntry[];
  epic?: { usd: number; durationMs: number };
  ownUsd?: number;
  mergeQueue?: { id: string; title: string }[];
  decisions?: string;
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
  const row = (task: TaskEntry): ReactElement => (
    <TaskRow
      key={`${task.title} ${task.proof}`}
      task={task}
      dependents={dependentsOf(task, tasks)}
      onSkip={onSkip}
      mark={markOf(revision, task.title)}
    />
  );
  return (
    <Box component="section" aria-label="Tasks" sx={{ my: 2, display: 'grid', gap: 1, minWidth: 0 }}>
      <Typography variant="subtitle2">Tasks</Typography>
      <Tooltip title={figures?.workedTip ?? ''}>
        <Typography variant="body2">
          {[`${tasks.length} tasks`, `${merged} merged`, ...(figures ? [figures.tasksMoney] : [])].join(' · ')}
        </Typography>
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
      {settled.length > 0 ? (
        <Box>
          <Button size="small" aria-expanded={settledOpen} onClick={() => setSettledOpen(!settledOpen)}>
            {`✓ ${merged} merged${skipped > 0 ? ` · ${skipped} skipped` : ''}`}
          </Button>
          {settledOpen ? (
            <Box component="ul" sx={{ m: 0, p: 0, display: 'grid', gap: 0.5 }}>
              {settled.map(row)}
            </Box>
          ) : null}
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
      {decisions ? <TaskDecisions text={decisions} /> : null}
    </Box>
  );
}
