import { useState, type ReactElement } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import { taskStateWord } from '@contract/run-state';
import { mergeBacklogTask } from '../../../lib/backlog-endpoints';
import { localTime } from '../../../lib/format';
import { RunStateIcon, toneColor } from '../../run';

type Task = BacklogView['tasks'][number];

/** One backlog task on one line: state, title and note, a link to its run, and Merge for the owner while it waits for the OK. */
export function BacklogTaskRow({
  backlog,
  task,
  owner,
  onView,
}: {
  backlog: string;
  task: Task;
  owner: boolean;
  onView: (view: BacklogView) => void;
}): ReactElement {
  const [merging, setMerging] = useState(false);
  const [refusal, setRefusal] = useState('');
  const word = taskStateWord({ status: task.status }, localTime);
  const color = toneColor(word.tone);
  const merge = async (): Promise<void> => {
    setMerging(true);
    setRefusal('');
    try {
      onView(await mergeBacklogTask(backlog, task.slug));
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : 'The merge was refused.');
    } finally {
      setMerging(false);
    }
  };
  return (
    <Box component="li" sx={{ listStyle: 'none', minWidth: 0, py: 0.5 }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
        <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color, flexShrink: 0 }}>
          <RunStateIcon view={word} size={16} />
          <Typography component="span" variant="caption" sx={{ color }}>
            {word.word}
          </Typography>
        </Box>
        <Typography variant="body2" noWrap sx={{ minWidth: 0, flex: '1 1 0' }}>
          {task.title}
        </Typography>
        {task.runKey ? (
          <Box
            component={Link}
            href={`/runs/${task.runKey}` as Route}
            aria-label={`Open run ${task.title}`}
            sx={{ flexShrink: 0, fontSize: 13 }}
          >
            Open run
          </Box>
        ) : null}
        {owner && task.waitsForOk ? (
          <Button size="small" variant="contained" disabled={merging} onClick={() => void merge()}>
            Merge
          </Button>
        ) : null}
      </Box>
      {task.note !== '' ? (
        <Typography variant="caption" color="text.secondary" sx={{ pl: 3, display: 'block' }}>
          {task.note}
        </Typography>
      ) : null}
      {refusal !== '' ? (
        <Typography role="alert" variant="caption" color="error" sx={{ pl: 3, display: 'block' }}>
          {refusal}
        </Typography>
      ) : null}
    </Box>
  );
}
