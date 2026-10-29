'use client';

import { ReactNode, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import Accordion from '@mui/material/Accordion';
import AccordionDetails from '@mui/material/AccordionDetails';
import AccordionSummary from '@mui/material/AccordionSummary';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Chip from '@mui/material/Chip';
import Typography from '@mui/material/Typography';
import { SeriesChart } from './charts/series';
import { MarkdownBody } from './markdown-body';
import { api } from '../lib/api';
import { count, duration, memory, money } from '../lib/format';
import { latestPhaseLabels } from '../lib/phases';
import { LogTranscript } from './log-transcript';
import { HistoryView } from '../lib/types';

export function HistoryScreen({ runKey }: { runKey: string }) {
  const [view, setView] = useState<HistoryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [visit, setVisit] = useState<number | null>(null);
  const [file, setFile] = useState<string | null>(null);

  useEffect(() => {
    api<HistoryView>(`/runs/${encodeURIComponent(runKey)}/history`)
      .then((body) => {
        setView(body);
        setVisit(body.stats.at(-1)?.id ?? null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'history failed'));
  }, [runKey]);

  const grouped = useMemo(() => {
    const map = new Map<string, HistoryView['documents']>();
    for (const document of view?.documents ?? []) {
      map.set(document.kind, [...(map.get(document.kind) ?? []), document]);
    }
    return [...map.entries()];
  }, [view]);

  const tokens = useMemo(() => {
    const byModel = new Map<string, { inn: number; out: number }>();
    for (const stat of view?.stats ?? []) {
      const key = stat.model ?? 'none';
      const current = byModel.get(key) ?? { inn: 0, out: 0 };
      byModel.set(key, { inn: current.inn + stat.tokensIn, out: current.out + stat.tokensOut });
    }
    return [...byModel.entries()];
  }, [view]);

  if (!view) {
    return <Typography color={error ? 'error' : 'text.secondary'}>{error ?? 'Loading history.'}</Typography>;
  }
  const samples = view.samples.filter((sample) => sample.stepStatId === visit);
  const opened = view.files.find((item) => `${item.name}:${item.path}` === file);
  return (
    <Box>
      <Button component={Link} href={`/runs/${runKey}`} color="inherit" sx={{ mb: 1 }}>
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
              <Chip key={label} size="small" variant="outlined" label={label} sx={{ height: 22, bgcolor: 'transparent', fontFamily: 'var(--font-mono)', fontSize: 12 }} />
            ))}
          </Box>
        )}
      </Section>
      <Section title="Documents">
        {grouped.length === 0 ? <Empty /> : null}
        {grouped.map(([kind, documents]) => (
          <Accordion key={kind} defaultExpanded={false} disableGutters elevation={0} sx={{ bgcolor: 'transparent', borderTop: 1, borderColor: 'divider' }}>
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
                    <MarkdownBody text={document.body} />
                  )}
                </Box>
              ))}
            </AccordionDetails>
          </Accordion>
        ))}
      </Section>
      <Section title="Files">
        {view.files.length === 0 ? <Empty /> : null}
        {view.files.map((item) => (
          <Box key={`${item.name}:${item.path}`} sx={{ py: 1, borderTop: 1, borderColor: 'divider' }}>
            <Button color="inherit" onClick={() => setFile(`${item.name}:${item.path}`)} sx={{ fontFamily: 'var(--font-mono)', fontSize: 13 }}>
              {item.name || item.path}
            </Button>
            {opened === item ? (
              item.body ? (
                <Typography component="pre" sx={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
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
          <Accordion key={index} disableGutters elevation={0} sx={{ bgcolor: 'transparent', borderTop: 1, borderColor: 'divider' }}>
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
          <Typography key={stat.id} sx={{ fontFamily: 'var(--font-mono)', fontSize: 13, py: 0.5 }}>
            {stat.step} #{stat.attempt} · {duration(stat.durationMs)} · {money(stat.usd)} · cpu {stat.cpuPeak.toFixed(0)}% · mem {memory(stat.memPeak)}
          </Typography>
        ))}
        <Box sx={{ mt: 2 }}>
          {tokens.map(([model, usage]) => (
            <Typography key={model} variant="body2">
              {model}: {count(usage.inn)} in, {count(usage.out)} out
            </Typography>
          ))}
        </Box>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', my: 2 }}>
          {view.stats.map((stat) => (
            <Button key={stat.id} size="small" variant={stat.id === visit ? 'contained' : 'text'} onClick={() => setVisit(stat.id)}>
              {stat.step} {stat.attempt}
            </Button>
          ))}
        </Box>
        <SeriesChart samples={samples} />
        {view.loops.map((loop) => (
          <Typography key={`${loop.counter}-${loop.attempt}`} variant="body2">
            {loop.counter} {loop.attempt}: {loop.reason}
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
    <Accordion defaultExpanded={false} disableGutters elevation={0} sx={{ bgcolor: 'transparent', border: 1, borderColor: 'divider', mb: 1 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Typography>{title}</Typography>
      </AccordionSummary>
      <AccordionDetails>{children}</AccordionDetails>
    </Accordion>
  );
}
