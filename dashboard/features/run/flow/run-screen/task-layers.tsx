import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { TaskLayer } from '@contract/api';

/** The tasks of a split plan, one block per dependency layer, with the status of each and a line for all. */
export function TaskLayers({
  layers,
  line,
  onSkip,
}: {
  layers: TaskLayer[];
  line?: string;
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
              <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: 'anywhere' }}>
                files: {task.files.join(', ')} · proof: {task.proof}
              </Typography>
            </Box>
          ))}
        </Box>
      ))}
    </Box>
  );
}
