import { type ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import type { StepEvent } from '@contract/step-events';
import { duration } from '../../../lib/format';
import { CardFrame } from './card-frame';
import { commandLine } from './transcript-model';

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

/** The directory of a command relative to its repo, so no path of the server shows. */
function inRepo(cwd: string, repo: string): string {
  const parts = cwd.split('/');
  const at = parts.lastIndexOf(repo);
  return at < 0 ? cwd : parts.slice(at + 1).join('/') || '.';
}

const PRE = {
  m: 0,
  maxHeight: 320,
  overflowY: 'auto',
  overflowX: 'hidden',
  minWidth: 0,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
} as const;

/** One command: the line, where and how it ended, and its output when it has some. The full args stay in the title. */
export function CommandBody({ event, end }: { event: Started; end: Finished | null }): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Box
        component="code"
        title={[event.executable, ...event.args].join(' ')}
        sx={{ display: 'block', minWidth: 0, overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)' }}
      >
        {commandLine(event)}
      </Box>
      <Box sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
        {event.repo ? `${event.repo} · ${inRepo(event.cwd, event.repo)}` : inRepo(event.cwd, '')} · {event.actor} ·{' '}
        {status(end)}
        {end ? ` · exit ${end.exitCode ?? 'none'} · ${duration(end.durationMs)}` : ''}
      </Box>
      {end?.output ? (
        <>
          <Button size="small" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
            {open ? 'Hide output' : 'Show output'}
          </Button>
          {open ? (
            <Box component="pre" sx={PRE}>
              {end.output}
            </Box>
          ) : null}
        </>
      ) : null}
    </>
  );
}

export function CommandCard({ event, end }: { event: Started; end: Finished | null }): ReactElement {
  return (
    <CardFrame side="left" label="Command">
      <CommandBody event={event} end={end} />
    </CardFrame>
  );
}
