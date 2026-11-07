import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import type { StepEvent } from '@contract/step-events';
import { duration } from '../../../lib/format';
import { CardFrame } from './card-frame';
import { CommandBody } from './command-card';
import type { TranscriptItem } from './transcript-model';

/** A named stretch of a step as one card. Its commands are inside, closed; the read-only git queries are only counted. */
export function ActivityCard({
  event,
  activity,
}: {
  event: Extract<StepEvent, { kind: 'activity.started' }>;
  activity: NonNullable<TranscriptItem['activity']>;
}): ReactElement {
  const { finished, commands, reads } = activity;
  const parts = [
    finished ? duration(finished.durationMs) : 'running',
    commands.length > 0 ? `${commands.length} commands` : '',
    reads > 0 ? `${reads} git reads` : '',
  ].filter(Boolean);
  return (
    <CardFrame
      side="left"
      label="Activity"
      meta={parts.join(' · ')}
      detail={
        commands.length > 0 ? (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1, mt: 0.5 }}>
            {commands.map((command) => (
              <Box key={command.event.eventId} sx={{ minWidth: 0 }}>
                {command.event.kind === 'command.started' ? (
                  <CommandBody event={command.event} end={command.end} />
                ) : null}
              </Box>
            ))}
          </Box>
        ) : undefined
      }
      detailLabel="commands"
    >
      <div>{event.title}</div>
      {finished?.result ? <div>{finished.result}</div> : null}
    </CardFrame>
  );
}

/** A run of read-only git queries that no activity holds, as one card. */
export function ReadsCard({ reads }: { reads: number }): ReactElement {
  return <CardFrame side="left" label="Git">{`${reads} git reads`}</CardFrame>;
}
