'use client';

import { RefObject } from 'react';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { statusColor } from '../../../theme/theme';
import { MarkdownBody } from '../../markdown-body';
import { duration } from '../../../lib/format';
import { StepView } from '../../../lib/types';
import { LogTranscript } from '../../log-transcript';
import { StepChart } from './step-chart';

export function StepDocuments({
  shownChecks,
  check,
  setCheck,
  visit,
  logs,
  document,
  logBox,
  stick,
}: {
  shownChecks: StepView['checks'];
  check: string | null;
  setCheck: (name: string) => void;
  visit: StepView['visits'][number] | undefined;
  logs: string;
  document: string;
  logBox: RefObject<HTMLDivElement | null>;
  stick: { current: boolean };
}) {
  return (
    <>
      {shownChecks.length > 0 ? (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2 }}>
          {shownChecks.map((item) => {
            const tone = item.decision === 'decision: ok' ? 'done' : item.decision === 'decision: return' ? 'waiting' : '';
            return (
              <Button
                key={item.name}
                size="small"
                variant={item.name === check ? 'contained' : 'outlined'}
                onClick={() => setCheck(item.name)}
                sx={
                  tone
                    ? item.name === check
                      ? { bgcolor: statusColor(tone), '&:hover': { bgcolor: statusColor(tone) } }
                      : { color: statusColor(tone), borderColor: statusColor(tone) }
                    : undefined
                }
              >
                {item.name} {item.decision?.replace('decision: ', '') ?? ''}
              </Button>
            );
          })}
        </Box>
      ) : null}
      <StepChart visit={visit} />
      {logs ? (
        <Box
          ref={logBox}
          onScroll={(event) => {
            const node = event.currentTarget;
            stick.current = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
          }}
          sx={{ mt: 2, maxHeight: 520, overflow: 'auto' }}
        >
          <LogTranscript raw={logs} />
        </Box>
      ) : null}
      {document ? <MarkdownBody text={document} /> : null}
      {visit?.exchanges.map((exchange, index) => (
        <Accordion key={`${exchange.model}-${index}`} disableGutters elevation={0} sx={{ borderTop: 1, borderColor: 'divider', bgcolor: 'transparent' }}>
          <AccordionSummary>
            <Typography variant="body2">
              {exchange.model} · {duration(exchange.durationMs)}
            </Typography>
          </AccordionSummary>
          <AccordionDetails>
            <Typography variant="overline">Request</Typography>
            <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {exchange.request}
            </Typography>
            <Typography variant="overline">Response</Typography>
            <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
              {exchange.response}
            </Typography>
          </AccordionDetails>
        </Accordion>
      ))}
    </>
  );
}
