import { useState, type ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import MenuItem from '@mui/material/MenuItem';
import Tab from '@mui/material/Tab';
import Tabs from '@mui/material/Tabs';
import TextField from '@mui/material/TextField';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import type { ChangeTaskBody } from '@contract/backlog-actions';
import { addBacklogTasks, changeBacklogTask } from '../../../lib/backlog-endpoints';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { taskSlug } from './task-slug';

type Task = BacklogView['tasks'][number];

const NONE = 'none';

/** The milestones a task may sit in: every one that is not accepted. */
export function openMilestones(view: BacklogView): BacklogView['milestones'] {
  return view.milestones.filter((item) => item.status !== 'accepted');
}

/** The changed fields of an edit, only. */
function changes(
  task: Task,
  next: Required<Pick<ChangeTaskBody, 'title' | 'description' | 'repositories' | 'depends' | 'milestone'>>,
): ChangeTaskBody {
  const body: ChangeTaskBody = {};
  if (next.title !== task.title) body.title = next.title;
  if (next.description !== task.description) body.description = next.description;
  if (next.repositories.join('\n') !== task.repositories.join('\n')) body.repositories = next.repositories;
  if (next.depends.join('\n') !== task.depends.join('\n')) body.depends = next.depends;
  if (next.milestone !== task.milestone) body.milestone = next.milestone;
  return body;
}

/** One dialog for Edit (a task is given) and + Task (only a preset milestone). */
export function TaskEditorDialog({
  view,
  task,
  milestone,
  onView,
  onClose,
}: {
  view: BacklogView;
  task?: Task;
  milestone: number | null;
  onView: (view: BacklogView) => void;
  onClose: () => void;
}): ReactElement {
  // The task as the dialog opened with: the form, the diff and the revision all stay on it while the view reloads.
  const [opened] = useState(task);
  const [title, setTitle] = useState(task?.title ?? '');
  const [description, setDescription] = useState(task?.description ?? '');
  const [preview, setPreview] = useState(false);
  const [repositories, setRepositories] = useState<string[]>(task?.repositories ?? view.repositories);
  const [depends, setDepends] = useState<string[]>(task?.depends ?? []);
  const [target, setTarget] = useState<number | null>(task ? task.milestone : milestone);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState('');
  const others = view.tasks.filter((item) => item.slug !== task?.slug);
  const save = async (): Promise<void> => {
    setBusy(true);
    setRefusal('');
    try {
      const next = { title: title.trim(), description, repositories, depends, milestone: target };
      onView(
        opened
          ? await changeBacklogTask(view.name, opened.slug, {
              ...changes(opened, next),
              expectedRevision: opened.revision,
            })
          : await addBacklogTasks(view.name, [
              {
                id: taskSlug(
                  next.title,
                  view.tasks.map((item) => item.slug),
                ),
                ...next,
              },
            ]),
      );
      onClose();
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : 'The task was refused.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" aria-labelledby="task-editor-title">
      <DialogTitle id="task-editor-title">{task ? 'Edit task' : 'New task'}</DialogTitle>
      <DialogContent sx={{ display: 'grid', gap: 2, pt: 1 }}>
        <TextField
          label="Title"
          size="small"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          sx={{ mt: 1 }}
        />
        <Box>
          <Tabs value={preview ? 1 : 0} onChange={(_event, value: number) => setPreview(value === 1)}>
            <Tab label="Write" />
            <Tab label="Preview" />
          </Tabs>
          {preview ? (
            <MarkdownBody text={description} />
          ) : (
            <TextField
              label="Description"
              multiline
              minRows={4}
              fullWidth
              size="small"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              sx={{ mt: 1 }}
            />
          )}
        </Box>
        <TextField
          select
          label="Repositories"
          size="small"
          value={repositories}
          slotProps={{ select: { multiple: true } }}
          onChange={(event) => setRepositories(event.target.value as unknown as string[])}
        >
          {view.repositories.map((name) => (
            <MenuItem key={name} value={name}>
              {name}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          label="Dependencies"
          size="small"
          value={depends}
          slotProps={{ select: { multiple: true } }}
          onChange={(event) => setDepends(event.target.value as unknown as string[])}
        >
          {others.map((item) => (
            <MenuItem key={item.slug} value={item.slug}>
              {item.title}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          label="Milestone"
          size="small"
          value={target === null ? NONE : String(target)}
          onChange={(event) => setTarget(event.target.value === NONE ? null : Number(event.target.value))}
        >
          <MenuItem value={NONE}>Backlog items</MenuItem>
          {openMilestones(view).map((item) => (
            <MenuItem key={item.number} value={String(item.number)}>
              {`M${item.number} · ${item.title}`}
            </MenuItem>
          ))}
        </TextField>
        {refusal !== '' ? (
          <Typography role="alert" variant="body2" color="error">
            {refusal}
          </Typography>
        ) : null}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" disabled={busy || title.trim() === ''} onClick={() => void save()}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** The + Task button: opens the editor with the milestone preset. */
export function AddTaskButton({
  view,
  milestone,
  onView,
}: {
  view: BacklogView;
  milestone: number | null;
  onView: (view: BacklogView) => void;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="small" onClick={() => setOpen(true)}>
        + Task
      </Button>
      {open ? (
        <TaskEditorDialog view={view} milestone={milestone} onView={onView} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
