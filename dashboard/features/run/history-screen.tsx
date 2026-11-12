'use client';

import type { ReactElement, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { AttemptSelector } from './attempt-selector';
import { SeriesChart } from './series';
import { getHistory, getRunLog } from '../../lib/endpoints';
import { count, duration, memory, money } from '../../lib/format';
import { documentsByKind, tokensByModel } from './history';
import { latestPhaseLabels } from './phases';
import { LOG_CHUNK } from './use-visit-log';
import { LogTranscript } from './log-transcript';
import { DocumentBody } from './transcript/document-detail';
import type { HistoryView } from '@contract/api';
import { visitKey } from '@contract/visit-key';

export function HistoryScreen({ runKey }: { runKey: string }): ReactElement {
  const [view, setView] = useState<HistoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visit, setVisit] = useState<number | null>(null);
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    getHistory(runKey)
      .then((body) => {
        setView(body);
        setVisit(body.stats.at(-1)?.id ?? null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'history failed'));
  }, [runKey]);

  const grouped = useMemo(() => documentsByKind(view?.documents ?? []), [view]);
  const tokens = useMemo(() => tokensByModel(view?.stats ?? []), [view]);

  if (!view) {
    return <Typography color={error ? 'error' : 'text.secondary'}>{error ?? 'Loading history.'}</Typography>;
  }
  const samples = view.samples.filter((sample) => sample.stepStatId === visit);
  const opened = view.files.find((item) => `${item.name}:${item.path}` === file);
  return (
    <Box>
      <Button component={Link} href={`/runs/${runKey}` as Route} color="inherit" sx={{ mb: 1 }}>
        Back to the flow
      </Button>
      <Typography variant="h5" sx={{ fontFamily: 'var(--font-mono)', mb: 2 }}>
        {runKey}
      </Typography>
      <Section title="Flows">
        {(view.launches ?? []).length === 0 ? (
          <Empty />
        ) : (
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
            {latestPhaseLabels(view.launches).map((label) => (
              <Chip
                key={label}
                size="small"
                variant="outlined"
                label={label}
                sx={{ height: 22, bgcolor: 'transparent', fontFamily: 'var(--font-mono)', fontSize: 12 }}
              />
            ))}
          </Box>
        )}
      </Section>
      <Section title="Documents">
        {grouped.length === 0 ? <Empty /> : null}
        {grouped.map(([kind, documents]) => (
          <Accordion
            key={kind}
            defaultExpanded={false}
            disableGutters
            elevation={0}
            sx={{ bgcolor: 'transparent', borderTop: 1, borderColor: 'divider' }}
          >
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>{kind}</AccordionSummary>
            <AccordionDetails>
              {documents.map((document, index) => (
                <Box key={`${kind}-${index}`} sx={{ mb: 2 }}>
                  <Typography variant="caption" color="text.secondary">
                    attempt {document.attempt}
                  </Typography>
                  {kind === 'log' ? (
                    <LogTranscript raw={document.body} />
                  ) : (
                    <DocumentBody kind={kind} body={document.body} />
                  )}
                </Box>
              ))}
            </AccordionDetails>
          </Accordion>
        ))}
        {view.stats
          .filter((stat) => stat.attemptId && stat.logLines > 0)
          .map((stat) => (
            <LogAccordion key={stat.attemptId} runKey={runKey} stat={stat} />
          ))}
      </Section>
      <Section title="Files">
        {view.files.length === 0 ? <Empty /> : null}
        {view.files.map((item) => (
          <Box key={`${item.name}:${item.path}`} sx={{ py: 1, borderTop: 1, borderColor: 'divider' }}>
            <Button
              color="inherit"
              onClick={() => setFile(`${item.name}:${item.path}`)}
              sx={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}
            >
              {item.name || item.path}
            </Button>
            {opened === item ? (
              item.body ? (
                <Typography
                  component="pre"
                  sx={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12 }}
                >
                  {item.body}
                </Typography>
              ) : (
                <Typography variant="body2">{item.path || 'binary'}</Typography>
              )
            ) : null}
          </Box>
        ))}
      </Section>
      <Section title="Prompts">
        {view.exchanges.length === 0 ? <Empty /> : null}
        {view.exchanges.map((exchange, index) => (
          <Accordion
            key={index}
            disableGutters
            elevation={0}
            sx={{ bgcolor: 'transparent', borderTop: 1, borderColor: 'divider' }}
          >
            <AccordionSummary expandIcon={<ExpandMoreIcon />}>
              {exchange.model} · {duration(exchange.durationMs)}
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
      </Section>
      <Section title="Metrics">
        {view.stats.length === 0 ? <Empty /> : null}
        {view.stats.map((stat) => (
          <Typography key={visitKey(stat.id)} sx={{ fontFamily: 'var(--font-mono)', fontSize: 13, py: 0.5 }}>
            {stat.step} #{stat.attempt} · {duration(stat.durationMs)} · {money(stat.usd)} · cpu{' '}
            {stat.cpuPeak.toFixed(0)}% · mem {memory(stat.memPeak)}
          </Typography>
        ))}
        <Box sx={{ mt: 2 }}>
          {tokens.map(([model, usage]) => (
            <Typography key={model} variant="body2">
              {model}: {count(usage.inn)} in, {count(usage.out)} out
            </Typography>
          ))}
        </Box>
        <Box sx={{ my: 2, minWidth: 0 }}>
          <AttemptSelector
            items={view.stats.map((stat) => ({
              key: visitKey(stat.id),
              label: `${stat.step} ${stat.attempt}`,
              color: 'primary.main',
              menuText: `${stat.step} #${stat.attempt} · ${duration(stat.durationMs)}`,
            }))}
            selected={visit === null ? undefined : visitKey(visit)}
            onSelect={(key) => setVisit(view.stats.find((stat) => visitKey(stat.id) === key)?.id ?? null)}
          />
        </Box>
        <SeriesChart samples={samples} />
        {view.loops.map((loop) => (
          <Typography key={`${loop.counter}-${loop.attempt}`} variant="body2">
            {loop.counter} {loop.attempt}: {loop.reason}
            {loop.ciOnly ? ' · CI only: no check covers it' : ''}
          </Typography>
        ))}
        {view.calls.map((call, index) => (
          <Typography key={index} sx={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            {call.method} {call.statusCode ?? '—'} {call.durationMs}ms {call.url}
            {call.error ? ` ${call.error}` : ''}
          </Typography>
        ))}
      </Section>
    </Box>
  );
}

function Empty() {
  return (
    <Typography variant="body2" color="text.secondary">
      Nothing stored yet.
    </Typography>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Accordion
      defaultExpanded={false}
      disableGutters
      elevation={0}
      sx={{ bgcolor: 'transparent', border: 1, borderColor: 'divider', mb: 1 }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography>{title}</Typography>
      </AccordionSummary>
      <AccordionDetails>{children}</AccordionDetails>
    </Accordion>
  );
}

/** The log of one visit, read from the server when the person opens it: its last lines. */
function LogAccordion({ runKey, stat }: { runKey: string; stat: HistoryView['stats'][number] }): ReactElement {
  const [raw, setRaw] = useState<string | null>(null);
  const open = (expanded: boolean): void => {
    if (expanded && raw === null && stat.attemptId) {
      getRunLog(runKey, stat.step, stat.attemptId, { tail: LOG_CHUNK })
        .then((text) => setRaw(text ?? ''))
        .catch(() => setRaw(''));
    }
  };
  return (
    <Accordion
      disableGutters
      elevation={0}
      onChange={(_, expanded) => open(expanded)}
      slotProps={{ transition: { unmountOnExit: true } }}
      sx={{ bgcolor: 'transparent', borderTop: 1, borderColor: 'divider' }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        log · {stat.step} · attempt {stat.attempt}
      </AccordionSummary>
      <AccordionDetails>{raw === null ? 'Loading log.' : <LogTranscript raw={raw} />}</AccordionDetails>
    </Accordion>
  );
}
