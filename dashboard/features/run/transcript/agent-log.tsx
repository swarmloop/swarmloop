import { type ReactElement, useState } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { duration } from '../../../lib/format';
import { LogTranscript } from '../log-transcript';
import { DETAIL } from './tokens';

export interface Exchange {
  model: string;
  durationMs: number;
  request: string;
  response: string;
}

/** What the window knows about the agent of the visit it shows: the streamed log and the model exchanges. */
export interface AgentLog {
  logs: string;
  running: boolean;
  exchanges: Exchange[];
}

export function Exchanges({ exchanges }: { exchanges: Exchange[] }): ReactElement {
  return (
    <Box id="exchanges">
      {exchanges.map((exchange, index) => (
        <Accordion
          key={`${exchange.model}-${index}`}
          disableGutters
          elevation={0}
          sx={{ borderTop: 1, borderColor: 'divider', bgcolor: 'transparent' }}
        >
          <AccordionSummary>
            <Typography variant="body2">
              {exchange.model} · {duration(exchange.durationMs)}
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Typography variant="overline">Request</Typography>
            <Typography
              component="pre"
              sx={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: DETAIL.fontSize }}
            >
              {exchange.request}
            </Typography>
            <Typography variant="overline">Response</Typography>
            <Typography
              component="pre"
              sx={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: DETAIL.fontSize }}
            >
              {exchange.response}
            </Typography>
          </AccordionDetails>
        </Accordion>
      ))}
    </Box>
  );
}

/**
 * The raw log of an agent and its exchanges. The log is open while the step runs and closed after.
 * `tools` says that the card lists the tool calls already, so the log is the raw one behind a button.
 */
export function AgentLogPanel({
  agent,
  tools,
  open: opened,
}: {
  agent: AgentLog;
  tools: boolean;
  /** Shows the log from the start, for a window that has no card of the agent to hold it. */
  open?: boolean;
}): ReactElement {
  const [shown, setShown] = useState<boolean | null>(null);
  const open = shown ?? opened ?? (agent.running && !tools);
  return (
    <>
      {agent.logs ? (
        <Box sx={{ mt: 1 }}>
          <Button size="small" onClick={() => setShown(!open)} aria-expanded={open}>
            {tools ? 'show raw log' : open ? 'hide log' : 'show log'}
          </Button>
          {open ? (
            <Box sx={{ mt: 1, maxHeight: DETAIL.maxHeight, overflow: 'auto' }}>
              <LogTranscript raw={agent.logs} />
            </Box>
          ) : null}
        </Box>
      ) : null}
      <Exchanges exchanges={agent.exchanges} />
    </>
  );
}
