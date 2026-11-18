import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import Typography from '@mui/material/Typography';
import type { FlowView } from '@contract/api';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { ciInfra, resumeLabel } from '../../../lib/ci-infra';
import { isLong, plainText } from './conversation-words';

const List = ({ lines }: { lines: string[] }): ReactElement => (
  <Box component="ul" sx={{ fontFamily: 'var(--font-mono)', fontSize: 13, pl: 2, my: 1 }}>
    {lines.map((line) => (
      <li key={line}>{line}</li>
    ))}
  </Box>
);

/** True when the run stopped on something a person fixes: a failed or blocked step, or a wait that Resume ends. */
export function hasProblem(flow: FlowView): boolean {
  if (flow.status === 'failed' || flow.status === 'blocked') {
    return true;
  }
  return flow.status === 'waiting' && flow.items.length === 0 && flow.actions.includes('resume');
}

/** A failed or blocked step: why in plain words, the CI jobs and paths it names, and Resume. */
export function ProblemEntry({ flow, onResume }: { flow: FlowView; onResume: () => void }): ReactElement {
  const infra = ciInfra(flow);
  const reason = infra ? plainText(infra.reason) : flow.reason ? plainText(flow.reason) : null;
  return (
    <Paper
      component="section"
      aria-label="Problem"
      variant="outlined"
      sx={{ p: 1.5, borderColor: 'error.main', overflowWrap: 'anywhere' }}
    >
      <Typography variant="body2">{plainText(flow.sentence)}</Typography>
      {reason ? (
        isLong(reason) ? (
          <Box component="details" sx={{ mt: 1 }}>
            <Box component="summary" sx={{ cursor: 'pointer', fontSize: 14 }}>
              Show the whole report
            </Box>
            <MarkdownBody text={reason} />
          </Box>
        ) : infra ? (
          <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {reason}
          </Typography>
        ) : (
          <MarkdownBody text={reason} />
        )
      ) : null}
      {infra ? <List lines={infra.jobs} /> : null}
      {flow.paths.length > 0 ? <List lines={flow.paths.map((item) => `${item.repo}/${item.path}`)} /> : null}
      {flow.actions.includes('resume') ? (
        <Button variant="contained" size="small" disabled={flow.resume !== 'ready'} onClick={onResume} sx={{ mt: 1 }}>
          {resumeLabel(flow.stateReason?.code)}
        </Button>
      ) : null}
    </Paper>
  );
}
