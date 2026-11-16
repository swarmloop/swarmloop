import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Typography from '@mui/material/Typography';
import type { TaskEntry } from '@contract/api';
import { MarkdownBody } from '../../../../components/ui/markdown-body';
import { TaskPaths } from './task-paths';

type Result = NonNullable<NonNullable<TaskEntry['run']>['result']>;

const files = (count: number): string => `${count} ${count === 1 ? 'file' : 'files'}`;

function Fold({ summary, children }: { summary: string; children: ReactElement }): ReactElement {
  return (
    <details>
      <summary>
        <Typography component="span" variant="body2">
          {summary}
        </Typography>
      </summary>
      {children}
    </details>
  );
}

/** What the task changed: its files, those outside the plan marked, the planned files it left alone, and whether its proof held. */
function TaskResult({ planned, result }: { planned: string[]; result: Result }): ReactElement {
  const untouched = planned.filter((path) => !result.files.includes(path));
  const proof = result.proofMet === null ? null : result.proofMet ? 'Proof met' : 'Proof not met';
  return (
    <Box>
      <Typography variant="subtitle2">Result</Typography>
      <Fold summary={`Changed ${files(result.files.length)}`}>
        <TaskPaths
          paths={[...result.files, ...untouched]}
          mark={(path) =>
            untouched.includes(path) ? 'planned, not changed' : planned.includes(path) ? null : 'not in plan'
          }
        />
      </Fold>
      {proof ? <Typography variant="body2">{proof}</Typography> : null}
    </Box>
  );
}

/** A task's plan (the files it will change and the proof it is done by) and, once it has a result, what it did. */
export function TaskDetails({
  files: planned,
  proof,
  result,
}: {
  files: string[];
  proof: string;
  result?: Result;
}): ReactElement {
  return (
    <Box sx={{ pl: 4, pb: 1, minWidth: 0, display: 'grid', gap: 1 }}>
      <Box>
        <Typography variant="subtitle2">Plan</Typography>
        {planned.length > 0 ? (
          <Fold summary={`Will change ${files(planned.length)}`}>
            <TaskPaths paths={planned} />
          </Fold>
        ) : null}
        {proof ? (
          <>
            <Typography variant="body2">Done when:</Typography>
            <MarkdownBody text={proof} />
          </>
        ) : null}
      </Box>
      {result ? <TaskResult planned={planned} result={result} /> : null}
    </Box>
  );
}
