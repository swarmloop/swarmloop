import { useState, type ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Tooltip from '@mui/material/Tooltip';
import Typography from '@mui/material/Typography';
import type { DecisionView } from '@contract/api';
import { MarkdownBody } from '../../../../components/ui/markdown-body';
import { when } from '../../../../lib/format';

const SHOWN = 6;

/** The ids and the exact time of a decision, for its tooltip only. */
function detail(decision: DecisionView): string {
  return [
    decision.taskId ? `task ${decision.taskId}` : '',
    decision.item ? `decision ${decision.item}` : '',
    decision.at ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function DecisionLine({ decision }: { decision: DecisionView }): ReactElement {
  const prefix = [decision.task, ...(decision.at ? [when(decision.at)] : [])].join(' · ');
  return (
    <Tooltip title={detail(decision)}>
      <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'baseline' }}>
        <Typography component="span" variant="body2" sx={{ flexShrink: 0 }}>
          {`${prefix} · `}
        </Typography>
        <MarkdownBody text={decision.text} />
      </Box>
    </Tooltip>
  );
}

/** The planner's decisions, one line each, folded to the first six when there are more. */
export function TaskDecisions({ decisions }: { decisions: DecisionView[] }): ReactElement {
  const [all, setAll] = useState(false);
  const long = decisions.length > SHOWN;
  return (
    <Box component="section" aria-label="Decisions">
      <Typography variant="subtitle2">Decisions</Typography>
      {(long && !all ? decisions.slice(0, SHOWN) : decisions).map((decision, index) => (
        <DecisionLine key={index} decision={decision} />
      ))}
      {long ? (
        <Button size="small" onClick={() => setAll(!all)}>
          {all ? 'Show less' : 'Show all'}
        </Button>
      ) : null}
    </Box>
  );
}
