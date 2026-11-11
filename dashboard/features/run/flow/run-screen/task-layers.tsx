import type { ReactElement } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { TaskLayer } from '@contract/api';
import { duration, money } from '../../../../lib/format';

/** The tasks of a split plan, one block per dependency layer, with the status of each and a line for all. */
export function TaskLayers({
  layers,
  line,
  mergeQueue,
  decisions,
  onSkip,
}: {
  layers: TaskLayer[];
  line?: string;
  mergeQueue?: { id: string; title: string }[];
  decisions?: string;
  onSkip: (taskId: string) => void;
}): ReactElement {
  return (
    <Box component="section" aria-label="Tasks" sx={{ my: 2, display: 'grid', gap: 1 }}>
      <Typography variant="subtitle2">Tasks</Typography>
      {line ? <Typography variant="body2">{line}</Typography> : null}
      {layers.map((layer) => (
        <Box key={layer.layer} sx={{ display: 'grid', gap: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Layer {layer.layer + 1}
          </Typography>
          {layer.tasks.map((task) => (
            <Box key={`${task.title} ${task.proof}`} sx={{ pl: 1, minWidth: 0 }}>
              <Typography variant="body2">
                {task.title} · {task.status}
                {task.note ? ` · ${task.note}` : ''}
                {task.status === 'blocked' ? (
                  <Button size="small" sx={{ ml: 1 }} onClick={() => onSkip(task.id)}>
                    Skip task
                  </Button>
                ) : null}
              </Typography>
              {task.run ? (
                <Typography variant="caption" color="text.secondary">
                  {task.run.currentStep} · {money(task.run.usd)} · {duration(task.run.durationMs)} ·{' '}
                  <Link href={`/runs/${task.run.key}` as Route}>Open run</Link>
                </Typography>
              ) : null}
              <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                files: {task.files.join(', ')} · proof: {task.proof}
              </Typography>
            </Box>
          ))}
        </Box>
      ))}
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
      {decisions ? (
        <Box component="section" aria-label="Decisions">
          <Typography variant="caption" color="text.secondary">
            decisions:
          </Typography>
          <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {decisions}
          </Typography>
        </Box>
      ) : null}
    </Box>
  );
}
