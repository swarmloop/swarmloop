import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import type { FlowView } from '@contract/api';
import { ciInfra, resumeLabel } from '../../../lib/ci-infra';
import { plainText } from './conversation-words';
import { ProblemCard } from './problem-card';

const List = ({ lines }: { lines: string[] }): ReactElement => (
  <Box component="ul" sx={{ fontFamily: 'var(--font-mono)', fontSize: 13, pl: 2, my: 1 }}>
    {lines.map((line) => (
      <li key={line}>{line}</li>
    ))}
  </Box>
);

/** A failed or blocked step: why in plain words, the CI jobs and paths it names, and Resume. */
export function ProblemEntry({ flow, onResume }: { flow: FlowView; onResume: () => void }): ReactElement {
  const infra = ciInfra(flow);
  const reason = infra ? plainText(infra.reason) : flow.reason ? plainText(flow.reason) : null;
  return (
    <ProblemCard
      sentence={plainText(flow.sentence)}
      reason={reason}
      preformatted={infra !== null}
      resume={
        flow.actions.includes('resume')
          ? { label: resumeLabel(flow.stateReason?.code), disabled: flow.resume !== 'ready', onClick: onResume }
          : undefined
      }
    >
      {infra ? <List lines={infra.jobs} /> : null}
      {flow.paths.length > 0 ? <List lines={flow.paths.map((item) => `${item.repo}/${item.path}`)} /> : null}
    </ProblemCard>
  );
}
