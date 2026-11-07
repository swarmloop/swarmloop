import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import type { StepEvent } from '@contract/step-events';
import { duration } from '../../../lib/format';
import { Bubble, Code, Detail } from './bubble';
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

/** The line of a command, and where and how it ended. The full args stay in the title. */
function CommandLine({ event, end }: { event: Started; end: Finished | null }): ReactElement {
  return (
    <>
      <Code title={[event.executable, ...event.args].join(' ')}>{commandLine(event)}</Code>
      <Box sx={{ color: 'text.secondary', overflowWrap: 'anywhere' }}>
        {event.repo ? `${event.repo} · ${inRepo(event.cwd, event.repo)}` : inRepo(event.cwd, '')} · {event.actor} ·{' '}
        {status(end)}
        {end ? ` · exit ${end.exitCode ?? 'none'} · ${duration(end.durationMs)}` : ''}
      </Box>
    </>
  );
}

const lineCount = (output: string): number => output.split('\n').length;

/** One command inside an activity bubble: the line, and its output behind the shared detail button. */
export function CommandBody({ event, end }: { event: Started; end: Finished | null }): ReactElement {
  return (
    <>
      <CommandLine event={event} end={end} />
      {end?.output ? (
        <Detail label="output" lines={lineCount(end.output)}>
          <Code>{end.output}</Code>
        </Detail>
      ) : null}
    </>
  );
}

export function CommandCard({ event, end }: { event: Started; end: Finished | null }): ReactElement {
  return (
    <Bubble
      side="left"
      title="Command"
      type="command"
      running={end === null}
      detail={end?.output ? <Code>{end.output}</Code> : undefined}
      detailLabel="output"
      detailLines={end?.output ? lineCount(end.output) : undefined}
    >
      <CommandLine event={event} end={end} />
    </Bubble>
  );
}
