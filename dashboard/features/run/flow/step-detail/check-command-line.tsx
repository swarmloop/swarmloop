'use client';

import { useState } from 'react';
import type { ReactElement } from 'react';
import CheckCircleOutline from '@mui/icons-material/CheckCircleOutline';
import ErrorOutline from '@mui/icons-material/ErrorOutline';
import PlayCircleOutline from '@mui/icons-material/PlayCircleOutline';
import Schedule from '@mui/icons-material/Schedule';
import SkipNext from '@mui/icons-material/SkipNext';
import Box from '@mui/material/Box';
import ButtonBase from '@mui/material/ButtonBase';
import type { CheckCommandView, StepView } from '@contract/api';
import { duration } from '../../../../lib/format';
import { statusColor } from '../../../../theme/theme';
import { useLiveBridge } from '../../../shell';
import { commandLabel, commandMs } from '../../check-commands';
import { useCommandLog } from '../../use-command-log';
import { CommandChart } from './step-chart';

const STATUS: Record<CheckCommandView['status'], { word: string; color: string; Icon: typeof Schedule }> = {
  waiting: { word: 'queued', color: 'text.secondary', Icon: Schedule },
  running: { word: 'running', color: statusColor('running'), Icon: PlayCircleOutline },
  passed: { word: 'passed', color: statusColor('done'), Icon: CheckCircleOutline },
  failed: { word: 'failed', color: statusColor('failed'), Icon: ErrorOutline },
  skipped: { word: 'skipped', color: statusColor('skipped'), Icon: SkipNext },
};

function CommandOutput({ runKey, command }: { runKey: string; command: CheckCommandView }): ReactElement {
  const live = useLiveBridge((snapshot) =>
    snapshot.logs.find((entry) => entry.key === runKey && entry.step === 'checks' && entry.command === command.index),
  );
  const stored = useCommandLog(runKey, command, true);
  const text = command.status === 'running' || command.status === 'waiting' ? (live?.body ?? stored) : stored;
  return (
    <Box
      component="pre"
      aria-label={`Output of ${command.command}`}
      sx={{
        m: 0,
        p: 1,
        maxHeight: 420,
        overflow: 'auto',
        fontFamily: 'var(--font-mono)',
        fontSize: 12,
        whiteSpace: 'pre-wrap',
      }}
    >
      {text ?? (command.status === 'waiting' || command.status === 'skipped' ? 'no output: it did not run' : 'loading')}
    </Box>
  );
}

/** One command of a checks visit: a line that opens in place to the full command, its output and its chart. A failed one starts open. */
export function CheckCommandLine({
  runKey,
  command,
  visit,
  now,
}: {
  runKey: string;
  command: CheckCommandView;
  visit: StepView['visits'][number] | undefined;
  now: number;
}): ReactElement {
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? command.status === 'failed';
  const ms = commandMs(command, now);
  const { word, color, Icon } = STATUS[command.status];
  return (
    <Box component="li" sx={{ listStyle: 'none' }}>
      <ButtonBase
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} ${commandLabel(command)}`}
        onClick={() => setToggled(!open)}
        sx={{ width: '100%', justifyContent: 'flex-start', gap: 1.5, py: 0.5, textAlign: 'left', fontSize: 13 }}
      >
        <Icon aria-hidden sx={{ fontSize: 18, color }} />
        <Box component="span" sx={{ fontFamily: 'var(--font-mono)', flex: 1, minWidth: 0 }}>
          {commandLabel(command)}
        </Box>
        <Box component="span" sx={{ color }}>
          {word}
        </Box>
        <Box component="span" sx={{ color: 'text.secondary' }}>
          {ms === null ? '' : duration(ms)}
        </Box>
        {command.status === 'failed' && command.exitCode !== null ? (
          <Box component="span" sx={{ color }}>
            exit {command.exitCode}
          </Box>
        ) : null}
      </ButtonBase>
      {open ? (
        <Box sx={{ ml: 3.5, mb: 1 }}>
          <Box sx={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'text.secondary', whiteSpace: 'pre-wrap' }}>
            {command.command}
          </Box>
          <CommandOutput runKey={runKey} command={command} />
          <CommandChart visit={visit} index={command.index} />
        </Box>
      ) : null}
    </Box>
  );
}
