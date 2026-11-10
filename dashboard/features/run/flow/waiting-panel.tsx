'use client';

import type { ReactElement } from 'react';
import { useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Paper from '@mui/material/Paper';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { resumeRun, sendAnswers } from '../../../lib/endpoints';
import { ciInfra, resumeLabel } from '../../../lib/ci-infra';
import { inState } from '../../../lib/run-actions';
import { answerPresentation } from '../../../lib/answer-field';
import type { AnswersBody, FlowView } from '@contract/api';

export function WaitingPanel({ flow, onChange }: { flow: FlowView; onChange: (flow: FlowView) => void }): ReactElement {
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const answers = flow.items.map((item) => ({ ...item, answer: drafts[`${item.kind}:${item.id}`] ?? item.answer }));
  const infra = ciInfra(flow);
  const complete = answers.every((item) => item.answer.trim() !== '');

  const save = (): void => {
    setBusy(true);
    sendAnswers(flow.key, {
      answers: answers.map((item) => ({ kind: item.kind, id: item.id, body: item.answer })),
    } satisfies AnswersBody)
      .then((next) => {
        setDrafts({});
        setError(null);
        onChange(next);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'answers failed'))
      .finally(() => setBusy(false));
  };

  const resume = (): void => {
    setBusy(true);
    resumeRun(flow.key)
      .then(() => onChange({ ...inState(flow, 'running'), status: 'running', resume: 'running', stepStartedAt: null }))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'resume failed'))
      .finally(() => setBusy(false));
  };

  return (
    <Paper sx={{ mt: 3, p: 2.5, border: 1, borderColor: 'divider' }}>
      <Typography>{flow.sentence}</Typography>
      {infra ? (
        <>
          <Typography
            component="pre"
            sx={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12, mt: 2 }}
          >
            {infra.reason}
          </Typography>
          <Box component="ul" sx={{ fontFamily: 'var(--font-mono)', fontSize: 13, pl: 2 }}>
            {infra.jobs.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </Box>
        </>
      ) : flow.reason ? (
        <Typography
          component="pre"
          sx={{ whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12, mt: 2 }}
        >
          {flow.reason}
        </Typography>
      ) : null}
      {flow.paths.length > 0 ? (
        <Box component="ul" sx={{ fontFamily: 'var(--font-mono)', fontSize: 13, pl: 2 }}>
          {flow.paths.map((item) => (
            <li key={`${item.repo}:${item.path}`}>
              {item.repo}/{item.path}
            </li>
          ))}
        </Box>
      ) : null}
      <Box sx={{ display: 'grid', gap: 1.5, mt: flow.items.length > 0 ? 2 : 0 }}>
        {answers.map((item) => {
          const presentation = answerPresentation(item);
          return (
            <Box key={`${item.kind}:${item.id}`} sx={{ display: 'grid', gap: 0.5 }}>
              {presentation.heading ? <Typography>{presentation.heading}</Typography> : null}
              <TextField
                label={presentation.label}
                slotProps={item.kind === 'question' ? { htmlInput: { 'aria-label': item.label } } : undefined}
                value={item.answer}
                onChange={(event) =>
                  setDrafts((current) => ({ ...current, [`${item.kind}:${item.id}`]: event.target.value }))
                }
                multiline
                minRows={2}
              />
            </Box>
          );
        })}
      </Box>
      {error ? (
        <Typography color="error" variant="body2" sx={{ mt: 1 }}>
          {error}
        </Typography>
      ) : null}
      {flow.actions.includes('answer') || flow.actions.includes('resume') ? (
        <Box sx={{ display: 'flex', gap: 1, mt: 2 }}>
          {flow.actions.includes('answer') && flow.items.length > 0 ? (
            <Button variant="contained" disabled={busy || !complete} onClick={save}>
              Submit
            </Button>
          ) : (
            <Button variant="contained" disabled={busy || flow.resume !== 'ready'} onClick={resume}>
              {resumeLabel(flow.stateReason?.code)}
            </Button>
          )}
        </Box>
      ) : null}
    </Paper>
  );
}
