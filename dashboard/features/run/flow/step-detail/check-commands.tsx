'use client';

import { useState } from 'react';
import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableHead from '@mui/material/TableHead';
import TableRow from '@mui/material/TableRow';
import Typography from '@mui/material/Typography';
import type { CheckCommandView } from '@contract/api';
import { duration } from '../../../../lib/format';
import { statusColor } from '../../../../theme/theme';
import { useLiveBridge } from '../../../shell';
import { commandMs } from '../../check-commands';
import { useCommandLog } from '../../use-command-log';

const TONE: Record<CheckCommandView['status'], string> = {
  waiting: 'waiting',
  running: 'running',
  passed: 'done',
  failed: 'failed',
  skipped: 'skipped',
};

function CommandOutput({ runKey, command }: { runKey: string; command: CheckCommandView }): ReactElement {
  const live = useLiveBridge((snapshot) =>
    snapshot.logs.find((entry) => entry.key === runKey && entry.step === 'checks' && entry.command === command.index),
  );
  const stored = useCommandLog(runKey, command, true);
  const text = command.status === 'running' ? (live?.body ?? stored) : stored;
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

/** The commands of one checks visit: each with its status, how long it took and its exit code; a row opens its full output. */
export function CheckCommands({
  runKey,
  commands,
  now,
}: {
  runKey: string;
  commands: CheckCommandView[];
  now: number;
}): ReactElement {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <Table size="small" sx={{ mt: 2 }} aria-label="Check commands">
      <TableHead>
        <TableRow>
          <TableCell>repository</TableCell>
          <TableCell>command</TableCell>
          <TableCell>status</TableCell>
          <TableCell align="right">duration</TableCell>
          <TableCell align="right">exit</TableCell>
          <TableCell />
        </TableRow>
      </TableHead>
      <TableBody>
        {commands.map((command) => {
          const ms = commandMs(command, now);
          const shown = open === command.index;
          return [
            <TableRow key={command.index}>
              <TableCell sx={{ fontFamily: 'var(--font-mono)' }}>{command.repo}</TableCell>
              <TableCell sx={{ fontFamily: 'var(--font-mono)' }} title={command.command}>
                {command.name ?? command.command}
              </TableCell>
              <TableCell sx={{ color: statusColor(TONE[command.status]) }}>{command.status}</TableCell>
              <TableCell align="right">{ms === null ? '' : duration(ms)}</TableCell>
              <TableCell align="right">{command.exitCode ?? ''}</TableCell>
              <TableCell align="right">
                <Button
                  size="small"
                  aria-expanded={shown}
                  aria-label={`${shown ? 'Hide' : 'Show'} output of ${command.command}`}
                  onClick={() => setOpen(shown ? null : command.index)}
                >
                  {shown ? 'hide output' : 'output'}
                </Button>
              </TableCell>
            </TableRow>,
            shown ? (
              <TableRow key={`${command.index}-output`}>
                <TableCell colSpan={6}>
                  <CommandOutput runKey={runKey} command={command} />
                </TableCell>
              </TableRow>
            ) : null,
          ];
        })}
        {commands.length === 0 ? (
          <TableRow>
            <TableCell colSpan={6}>
              <Typography color="text.secondary">This visit has no check commands.</Typography>
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </Table>
  );
}
