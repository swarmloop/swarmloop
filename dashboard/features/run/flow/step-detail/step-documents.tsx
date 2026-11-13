'use client';

import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Typography from '@mui/material/Typography';
import { statusColor } from '../../../../theme/theme';
import { MarkdownBody } from '../../../../components/ui/markdown-body';
import type { CheckCommandView, StepView } from '@contract/api';
import type { StepEvent } from '@contract/step-events';
import { LogTranscript } from '../../log-transcript';
import type { AgentRole } from '../../transcript/agent-card';
import { AgentLogPanel, Exchanges, type AgentLog } from '../../transcript/agent-log';
import { DocumentBody } from '../../transcript/document-detail';
import { TranscriptFeed } from '../../transcript/transcript-feed';
import type { IssueLinks } from '../../transcript/transcript-model';
import { CheckCommands } from './check-commands';
import { StepChart } from './step-chart';

/** The documents of a visit from before events were kept, once each. The log and the review documents have their own place. */
function legacyDocuments(visit: StepView['visits'][number] | undefined): StepView['visits'][number]['documents'] {
  const latest = new Map<string, StepView['visits'][number]['documents'][number]>();
  for (const item of visit?.documents ?? []) {
    if (item.kind !== 'log' && !item.kind.startsWith('review_') && item.body) {
      latest.set(item.kind, item);
    }
  }
  return [...latest.values()];
}

export function StepDocuments({
  runKey,
  events,
  issues,
  shownChecks,
  check,
  setCheck,
  visit,
  logs,
  document,
  role,
  commands,
  now = 0,
}: {
  runKey: string;
  /** What the step recorded: null while it is read, empty for a visit from before events were kept. */
  events: StepEvent[] | null;
  /** The issues of the whole run, for the link from a card to the window the issue came from. */
  issues: IssueLinks;
  shownChecks: StepView['checks'];
  check: string | null;
  setCheck: (name: string) => void;
  visit: StepView['visits'][number] | undefined;
  logs: string;
  document: string;
  /** The role and tier of the step's agent, from its descriptor. */
  role?: AgentRole | null;
  /** The check commands of the visit, for the checks step. */
  commands?: CheckCommandView[];
  now?: number;
}): ReactElement {
  const recorded = events !== null && events.length > 0;
  const agentStep = Boolean(visit?.model) || (visit?.exchanges.length ?? 0) > 0;
  const launched = events?.some((event) => event.kind === 'agent.launched') ?? false;
  const agent: AgentLog = { logs, running: visit?.status === 'running', exchanges: visit?.exchanges ?? [] };
  return (
    <>
      {shownChecks.length > 0 ? (
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2 }}>
          {shownChecks.map((item) => {
            const tone =
              item.decision === 'decision: ok' ? 'done' : item.decision === 'decision: return' ? 'returned' : '';
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
      {commands ? <CheckCommands runKey={runKey} commands={commands} now={now} /> : null}
      <StepChart visit={visit} />
      {events === null || recorded ? (
        <TranscriptFeed
          runKey={runKey}
          events={events}
          issues={issues}
          agent={agentStep ? agent : null}
          role={role}
          live={visit?.status === 'running'}
          now={now}
        />
      ) : null}
      {recorded && agentStep && !launched ? <AgentLogPanel agent={agent} tools={false} open /> : null}
      {events?.length === 0 && logs ? (
        <Box sx={{ mt: 2, border: 1, borderColor: 'divider', borderRadius: 1, p: 1, minWidth: 0 }}>
          <Typography variant="caption" color="text.secondary">
            legacy: details not recorded
          </Typography>
          <Box sx={{ mt: 1, maxHeight: 520, overflow: 'auto' }}>
            <LogTranscript raw={logs} />
          </Box>
        </Box>
      ) : null}
      {document ? <MarkdownBody text={document} /> : null}
      {events?.length === 0
        ? legacyDocuments(visit).map((item) => (
            <Box key={item.kind} sx={{ mt: 2, minWidth: 0 }}>
              <Typography variant="caption" color="text.secondary">
                {item.kind}
              </Typography>
              <DocumentBody kind={item.kind} body={item.body} />
            </Box>
          ))
        : null}
      {events?.length === 0 ? <Exchanges exchanges={visit?.exchanges ?? []} /> : null}
    </>
  );
}
