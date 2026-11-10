import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { TaskLayer } from '@contract/api';

/** The tasks of a split plan, one block per dependency layer. */
export function TaskLayers({ layers }: { layers: TaskLayer[] }): ReactElement {
  return (
    <Box component="section" aria-label="Tasks" sx={{ my: 2, display: 'grid', gap: 1 }}>
      <Typography variant="subtitle2">Tasks</Typography>
      {layers.map((layer) => (
        <Box key={layer.layer} sx={{ display: 'grid', gap: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Layer {layer.layer + 1}
          </Typography>
          {layer.tasks.map((task) => (
            <Box key={`${task.title} ${task.proof}`} sx={{ pl: 1, minWidth: 0 }}>
              <Typography variant="body2">{task.title}</Typography>
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
