'use client';

import { useEffect, useRef, useState } from 'react';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { api } from '../../lib/api';
import { mergeNames } from '../../lib/names';
import { PHASES, PhaseName } from '../../lib/phases';
import { PhasePicker } from './phase-picker';
import { ProjectPicker } from './project-picker';

const DEFAULT_PHASES: PhaseName[] = [...PHASES];

export function NewRunDialog({
  open,
  onClose,
  onCreated,
  title = 'New run',
  action = 'Start',
  selected,
  locked,
  lockedProjects,
  runKey,
  onProjects,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onCreated?: (key: string) => void;
  title?: string;
  action?: string;
  selected?: PhaseName[];
  locked?: PhaseName[];
  lockedProjects?: string[];
  runKey?: string;
  onProjects?: (projects: string[]) => void;
  onSubmit?: (prompt: string, phases: PhaseName[]) => Promise<'hold' | void>;
}) {
  const [prompt, setPrompt] = useState('');
  const [picked, setPicked] = useState<PhaseName[]>(selected ?? DEFAULT_PHASES);
  const [available, setAvailable] = useState<string[]>(lockedProjects ?? []);
  const [pickedProjects, setPickedProjects] = useState<string[]>(lockedProjects ?? []);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const kept = useRef<string[]>(lockedProjects ?? []);
  const frozen: PhaseName[] = locked ?? ['requirements'];
  const chosen = PHASES.filter((phase) => phase === 'requirements' || picked.includes(phase));
  const frozenProjects = lockedProjects !== undefined;
  const needProjects = !frozenProjects && pickedProjects.length === 0;
  const projectOptions = frozenProjects ? mergeNames(available, pickedProjects) : available;

  useEffect(() => {
    if (!open) {
      return;
    }
    if (!frozenProjects) {
      api<{ projects: string[] }>('/checkouts/projects')
        .then((body) => {
          setAvailable(body.projects);
          setPickedProjects([]);
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'projects failed'));
      return;
    }
    api<{ projects: string[] }>('/checkouts/projects')
      .then((body) => setAvailable(body.projects))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'projects failed'));
  }, [open, frozenProjects]);

  useEffect(() => {
    if (!open || lockedProjects === undefined) {
      return;
    }
    const next = mergeNames(kept.current, lockedProjects);
    if (next.length === kept.current.length) {
      return;
    }
    kept.current = next;
    setPickedProjects(next);
  }, [open, lockedProjects]);

  const changeProjects = (value: string[]): void => {
    if (!frozenProjects) {
      setPickedProjects(value);
      return;
    }
    if (busy || kept.current.some((name) => !value.includes(name))) {
      return;
    }
    const added = value.filter((name) => !kept.current.includes(name));
    if (added.length === 0 || !runKey) {
      if (added.length > 0) {
        setError('project failed');
      }
      return;
    }
    const key = runKey;
    const base = kept.current;
    setBusy(true);
    setError(null);
    void postProjects(key, base, added)
      .then((posted) => {
        if (posted.note) {
          setNote(posted.note);
        }
        if (posted.error) {
          setError(posted.error);
        }
        const next = mergeNames(kept.current, posted.projects);
        kept.current = next;
        setPickedProjects(next);
        if (posted.told) {
          onProjects?.(posted.told);
        }
      })
      .finally(() => setBusy(false));
  };

  const submit = (): void => {
    const text = prompt.trim();
    if (!text || needProjects || busy) {
      return;
    }
    setBusy(true);
    setError(null);
    const done = (created?: string): void => {
      setPrompt('');
      setPicked(selected ?? DEFAULT_PHASES);
      setPickedProjects(lockedProjects ?? []);
      if (created && onCreated) {
        onCreated(created);
      }
    };
    const request = onSubmit
      ? onSubmit(text, chosen).then((held) => {
          if (held !== 'hold') {
            done();
            onClose();
          }
        })
      : api<{ key: string }>('/runs', {
          method: 'POST',
          body: JSON.stringify({ prompt: text, phases: chosen, projects: pickedProjects }),
        }).then((body) => done(body.key));
    request.catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'run failed')).finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, '&&': { pt: 2.5 } }}>
        <TextField
          autoFocus
          label="Prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          required
          multiline
          minRows={6}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        <PhasePicker picked={picked} frozen={frozen} setPicked={setPicked} />
        <ProjectPicker frozenProjects={frozenProjects} projectOptions={projectOptions} pickedProjects={pickedProjects} onChange={changeProjects} />
        {note ? <Typography variant="body2">{note}</Typography> : null}
        {error ? (
          <Typography color="error" variant="body2">
            {error}
          </Typography>
        ) : null}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={busy || prompt.trim() === '' || needProjects} onClick={submit}>
          {action}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

async function postProjects(
  runKey: string,
  base: readonly string[],
  names: readonly string[],
): Promise<{ projects: string[]; note: string | null; error: string | null; told: string[] | null }> {
  let projects = [...base];
  const notes: string[] = [];
  let told: string[] | null = null;
  for (const name of names) {
    try {
      const body = await api<{ projects: string[]; applied: boolean }>(`/runs/${encodeURIComponent(runKey)}/projects`, {
        method: 'POST',
        body: JSON.stringify({ name }),
      });
      projects = mergeNames(projects, body.projects);
      told = body.projects;
      notes.push(body.applied ? `${name} is mounted.` : `${name} will be mounted on the next step.`);
    } catch (cause: unknown) {
      return {
        projects,
        note: notes.length > 0 ? notes.join(' ') : null,
        error: cause instanceof Error ? cause.message : 'project failed',
        told,
      };
    }
  }
  return { projects, note: notes.join(' '), error: null, told };
}
