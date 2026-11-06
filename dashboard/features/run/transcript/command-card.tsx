import { type ReactElement, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import type { StepEvent } from '@contract/step-events';
import { getHistory } from '../../../lib/endpoints';
import { duration } from '../../../lib/format';
import { CardFrame } from './card-frame';

const HISTORY_STALE_MS = 60_000;

type Started = Extract<StepEvent, { kind: 'command.started' }>;
type Finished = Extract<StepEvent, { kind: 'command.finished' }>;

function status(end: Finished | null): string {
  if (!end) {
    return 'running';
  }
  if (end.timedOut) {
    return 'timed out';
  }
  return end.cancelled ? 'cancelled' : 'finished';
}

/** The stored output behind a reference: the file of the run history with that path. */
function Output({ runKey, path }: { runKey: string; path: string | null }): ReactElement {
  const history = useQuery({
    queryKey: ['history', runKey],
    queryFn: () => getHistory(runKey),
    enabled: path !== null,
    // One read of the history serves every card of the run.
    staleTime: HISTORY_STALE_MS,
    refetchOnWindowFocus: false,
  });
  const body = history.data?.files.find((file) => file.path === path)?.body ?? null;
  if (history.isPending && path !== null) {
    return <span>loading output</span>;
  }
  if (body === null) {
    return <span>output not stored</span>;
  }
  return (
    <Box
      component="pre"
      sx={{
        m: 0,
        maxHeight: 320,
        overflowY: 'auto',
        overflowX: 'hidden',
        minWidth: 0,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'anywhere',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
      }}
    >
      {body}
    </Box>
  );
}

export function CommandCard({
  runKey,
  event,
  end,
}: {
  runKey: string;
  event: Started;
  end: Finished | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <CardFrame side="left" label="Command">
      <Box
        component="code"
        sx={{ display: 'block', minWidth: 0, overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)' }}
      >
        {[event.executable, ...event.args].join(' ')}
      </Box>
      <Box sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
        {event.repo} · {event.cwd} · {event.actor} · {status(end)}
        {end ? ` · exit ${end.exitCode ?? 'none'} · ${duration(end.durationMs)}` : ''}
      </Box>
      {end ? (
        <>
          <Button size="small" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            {open ? 'Hide output' : 'Show output'}
          </Button>
          {open ? <Output runKey={runKey} path={end.output} /> : null}
        </>
      ) : null}
    </CardFrame>
  );
}
