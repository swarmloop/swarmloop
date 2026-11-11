import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import { SeriesChart, type SeriesLine } from '../../series';
import type { StepView } from '@contract/api';

type Sample = StepView['visits'][number]['samples'][number];

/** The name a source has in the legend: `agent`, `setup`, or `command <index>`. */
function sourceLabel(source: string): string {
  return /^\d+$/.test(source) ? `command ${source}` : source;
}

/** The step total at each sample time: every source counts with the last value it had. */
function totalLine(samples: Sample[]): SeriesLine {
  const latest = new Map<string, Sample>();
  const total: SeriesLine['samples'] = [];
  for (const sample of [...samples].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    latest.set(sample.source, sample);
    const current = [...latest.values()];
    total.push({
      at: sample.at,
      cpu: current.reduce((sum, item) => sum + item.cpu, 0),
      memory: current.reduce((sum, item) => sum + item.memory, 0),
    });
  }
  return { label: 'total', samples: total };
}

/** One line per source and the step total, or the line itself when the step sampled one source. */
function sourceLines(samples: Sample[]): SeriesLine[] | undefined {
  const sources = [...new Set(samples.map((sample) => sample.source))];
  if (sources.length < 2) {
    return undefined;
  }
  return [
    ...sources.map((source) => ({
      label: sourceLabel(source),
      samples: samples.filter((item) => item.source === source),
    })),
    totalLine(samples),
  ];
}

/** The chart of the containers the visit started. The server process itself is not a container. */
export function StepChart({ visit }: { visit: StepView['visits'][number] | undefined }): ReactElement | null {
  if (!visit) {
    return null;
  }
  const samples = visit.samples.filter((sample) => sample.source !== 'server');
  if (samples.length === 0 && visit.status !== 'running') {
    return (
      <Typography color="text.secondary" sx={{ mt: 2, fontSize: 13 }}>
        This step started no container.
      </Typography>
    );
  }
  return (
    <Box sx={{ mt: 2 }}>
      <SeriesChart samples={samples} lines={sourceLines(samples)} />
    </Box>
  );
}
