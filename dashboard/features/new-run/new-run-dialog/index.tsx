'use client';

import { type ReactElement, useEffect, useRef, useState } from 'react';
import Button from '@mui/material/Button';
import Checkbox from '@mui/material/Checkbox';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import FormControlLabel from '@mui/material/FormControlLabel';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import { createRun, listProjects, listRemote, setRunProjects, ticketKeys } from '../../../lib/endpoints';
import { mergeNames } from '../../../lib/names';
import type { PhaseName } from '@contract/steps';
import { PHASES } from '@contract/steps';
import type { CreateRunBody, RemoteEntry, RemoteListView } from '@contract/api';
import { PhasePicker } from './phase-picker';
import { ProjectPicker } from './project-picker';

const PREVIEW_DELAY_MS = 300;
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
}): ReactElement {
  const [prompt, setPrompt] = useState('');
  const [picked, setPicked] = useState<PhaseName[]>(selected ?? DEFAULT_PHASES);
  const [available, setAvailable] = useState<string[]>(lockedProjects ?? []);
  const [pickedProjects, setPickedProjects] = useState<string[]>(lockedProjects ?? []);
  const [remote, setRemote] = useState<RemoteListView | null>(null);
  const [split, setSplit] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState<string[]>([]);
  const kept = useRef<string[]>(lockedProjects ?? []);
  const frozen: PhaseName[] = locked ?? ['planning'];
  const chosen = PHASES.filter((phase) => phase === 'planning' || picked.includes(phase));
  const frozenProjects = lockedProjects !== undefined;
  const needProjects = !frozenProjects && pickedProjects.length === 0;
  const projectOptions = frozenProjects ? mergeNames(available, pickedProjects) : available;

  useEffect(() => {
    if (!open) {
      return;
    }
    // A failed remote load leaves local folders working and shows no remote entries.
    listRemote()
      .then(setRemote)
      .catch(() => setRemote(null));
    if (!frozenProjects) {
      listProjects()
        .then((body) => {
          setAvailable(body.projects);
          setPickedProjects([]);
          setSplit(body.split ?? false);
        })
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'projects failed'));
      return;
    }
    listProjects()
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

  useEffect(() => {
    const text = prompt.trim();
    if (!open || !text) {
      setKeys([]);
      return;
    }
    let current = true;
    const timer = setTimeout(() => {
      ticketKeys({ prompt: text, key: runKey })
        .then((body) => current && setKeys(body.keys))
        .catch(() => current && setKeys([]));
    }, PREVIEW_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, prompt, runKey]);

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

  const created = (entry: RemoteEntry): void => {
    setAvailable((current) => mergeNames(current, [entry.name]));
    changeProjects(mergeNames(frozenProjects ? kept.current : pickedProjects, [entry.name]));
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
      : createRun({ prompt: text, phases: chosen, projects: pickedProjects, split } satisfies CreateRunBody).then(
          (body) => done(body.key),
        );
    request
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'run failed'))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, '&&': { pt: 2.5 } }}>
        <TextField
          // eslint-disable-next-line jsx-a11y/no-autofocus -- the prompt is the dialog's first field, so it takes focus when the dialog opens
          autoFocus
          label="Prompt"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          required
          multiline
          minRows={6}
          slotProps={{ inputLabel: { shrink: true } }}
        />
        {prompt.trim() ? (
          <Typography variant="body2" color="text.secondary">
            {keys.length > 0 ? `Jira: ${keys.join(', ')}` : 'no Jira tickets'}
          </Typography>
        ) : null}
        <PhasePicker picked={picked} frozen={frozen} setPicked={setPicked} />
        {onSubmit ? null : (
          <FormControlLabel
            control={<Checkbox checked={split} onChange={(event) => setSplit(event.target.checked)} />}
            label="May split into subtasks"
          />
        )}
        <ProjectPicker
          frozenProjects={frozenProjects}
          projectOptions={projectOptions}
          pickedProjects={pickedProjects}
          onChange={changeProjects}
          remote={remote}
          onCreated={created}
        />
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
      const body = await setRunProjects(runKey, name);
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
