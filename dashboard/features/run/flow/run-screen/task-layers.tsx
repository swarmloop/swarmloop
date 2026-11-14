import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import LinearProgress from '@mui/material/LinearProgress';
import Typography from '@mui/material/Typography';
import type { TaskLayer } from '@contract/api';
import { needsPerson } from '@contract/run-state';
import { orderTasks, taskGroup } from '@contract/task-order';
import { duration, money } from '../../../../lib/format';
import { TaskDecisions } from './task-decisions';
import { TaskRow } from './task-row';

/** `7 tasks · 7 merged · 4h 25m · $14.68`: the sums cover the tasks that have started. */
function summaryLine(tasks: TaskLayer['tasks']): string {
  const runs = tasks.flatMap((task) => (task.run ? [task.run] : []));
  const merged = tasks.filter((task) => task.status === 'merged').length;
  const totals =
    runs.length > 0
      ? [
          duration(runs.reduce((sum, run) => sum + run.durationMs, 0)),
          money(runs.reduce((sum, run) => sum + run.usd, 0)),
        ]
      : [];
  return [`${tasks.length} tasks`, `${merged} merged`, ...totals].join(' · ');
}

/** The tasks of a split plan: one row per task in the shared task order, with the merge queue and the decisions below. */
export function TaskLayers({
  layers,
  mergeQueue,
  decisions,
  onSkip,
}: {
  layers: TaskLayer[];
  mergeQueue?: { id: string; title: string }[];
  decisions?: string;
  onSkip: (taskId: string) => void;
}): ReactElement {
  // Plan order, as the run list gives them to `orderTasks`, not the order of the layers.
  const tasks = layers.flatMap((layer) => layer.tasks).sort((a, b) => a.index - b.index);
  const merged = tasks.filter((task) => task.status === 'merged').length;
  const { open, settled } = orderTasks(tasks, (task) =>
    taskGroup(task.status, task.run !== undefined && needsPerson(task.run.state, task.run.stateReason)),
  );
  return (
    <Box component="section" aria-label="Tasks" sx={{ my: 2, display: 'grid', gap: 1, minWidth: 0 }}>
      <Typography variant="subtitle2">Tasks</Typography>
      <Typography variant="body2">{summaryLine(tasks)}</Typography>
      <LinearProgress
        variant="determinate"
        value={tasks.length > 0 ? (merged / tasks.length) * 100 : 0}
        aria-label="Merged"
        sx={{ height: 4, borderRadius: 2 }}
      />
      <Box component="ul" sx={{ m: 0, p: 0, display: 'grid', gap: 0.5 }}>
        {[...open, ...settled].map((task) => (
          <TaskRow key={`${task.title} ${task.proof}`} task={task} onSkip={onSkip} />
        ))}
      </Box>
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
