import type { ReactElement } from 'react';
import { useState } from 'react';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import Typography from '@mui/material/Typography';
import { DisclosureIcon } from '../../../../components/ui/disclosure-icon';
import { SeriesChart, type SeriesLine } from '../../series';
import { cores, memory } from '../../../../lib/format';
import type { CheckCommandView, StepView } from '@contract/api';
import { NO_SAMPLES_AFTER_RESTART } from '@contract/restart-wait';

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

/** One line per source and the step total, or the one source's own line when the step sampled one source. */
function sourceLines(samples: Sample[]): SeriesLine[] {
  const sources = [...new Set(samples.map((sample) => sample.source))];
  if (sources.length < 2) {
    return [{ label: sourceLabel(sources[0]), samples }];
  }
  return [
    ...sources.map((source) => ({
      label: sourceLabel(source),
      samples: samples.filter((item) => item.source === source),
    })),
    totalLine(samples),
  ];
}

function NoSamplesLine(): ReactElement {
  return (
    <Typography color="text.secondary" sx={{ mt: 2, fontSize: 13 }}>
      {NO_SAMPLES_AFTER_RESTART}
    </Typography>
  );
}

/** The sentence of a step that started no container. */
export const NO_CONTAINER = 'This step started no container.';

/** A visit shorter than this has no resource charts. */
const MIN_CHART_MS = 60_000;

/** How long the visit ran: its duration, or the span of its samples while it runs. */
function visitSpanMs(visit: StepView['visits'][number], samples: Sample[]): number {
  if (visit.status !== 'running') {
    return visit.durationMs;
  }
  const times = samples.map((sample) => Date.parse(sample.at));
  return times.length > 0 ? Math.max(...times) - Math.min(...times) : 0;
}

/** The collapsed `Resources` line of a visit; it opens the CPU and memory charts. */
function Resources({ visit, lines }: { visit: StepView['visits'][number]; lines: SeriesLine[] }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ mt: 2 }}>
      <ButtonBase
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        sx={{ gap: 0.5, fontSize: 13, color: 'text.secondary' }}
      >
        <DisclosureIcon open={open} />
        {`Resources: ${cores(visit.cpuAvg)} cores avg · ${cores(visit.cpuPeak)} peak · ${memory(visit.memPeak)} peak`}
      </ButtonBase>
      {open ? (
        <>
          <SeriesChart samples={[]} lines={lines} metric="cpu" />
          <SeriesChart samples={[]} lines={lines} metric="memory" />
        </>
      ) : null}
    </Box>
  );
}

/** The step ran, started no container and is not the restart case: it has nothing to draw. */
export function startedNoContainer(visit: StepView['visits'][number] | undefined, restarted: boolean): boolean {
  if (!visit) {
    return false;
  }
  const samples = visit.samples.filter((sample) => sample.source !== 'server');
  return samples.length === 0 && visit.killReason !== 'process died' && !restarted && visit.status !== 'running';
}

/** The resources of the containers the visit started. The server process itself is not a container. */
export function StepChart({
  visit,
  total = false,
  restarted = false,
  feed = false,
}: {
  visit: StepView['visits'][number] | undefined;
  /** Draw the step total only, not a line for each source. */
  total?: boolean;
  /** The server restarted while the visit's agent kept running. */
  restarted?: boolean;
  /** The transcript is shown: it carries the no-container sentence in its top line. */
  feed?: boolean;
}): ReactElement | null {
  if (!visit) {
    return null;
  }
  const samples = visit.samples.filter((sample) => sample.source !== 'server');
  if (samples.length === 0 && (visit.killReason === 'process died' || restarted)) {
    return <NoSamplesLine />;
  }
  if (startedNoContainer(visit, restarted)) {
    return feed ? null : (
      <Typography color="text.secondary" sx={{ mt: 2, fontSize: 13 }}>
        {NO_CONTAINER}
      </Typography>
    );
  }
  if (visitSpanMs(visit, samples) < MIN_CHART_MS) {
    return null;
  }
  return <Resources visit={visit} lines={total ? [totalLine(samples)] : sourceLines(samples)} />;
}

/** The chart of one check command: the samples of its container. */
export function CommandChart({
  visit,
  command,
}: {
  visit: StepView['visits'][number] | undefined;
  command: CheckCommandView;
}): ReactElement {
  const samples = (visit?.samples ?? []).filter((sample) => sample.source === String(command.index));
  if (samples.length === 0 && command.status === 'interrupted') {
    return <NoSamplesLine />;
  }
  return <SeriesChart samples={samples} />;
}
