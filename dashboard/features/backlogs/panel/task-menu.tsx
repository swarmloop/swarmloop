import { useState, type ReactElement } from 'react';
import type { Route } from 'next';
import Link from 'next/link';
import IconButton from '@mui/material/IconButton';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import MoreVert from '@mui/icons-material/MoreVert';
import Typography from '@mui/material/Typography';
import type { BacklogView } from '@contract/backlog';
import {
  changeBacklogTask,
  deleteBacklogTask,
  runBacklogTaskNow,
  skipBacklogTask,
} from '../../../lib/backlog-endpoints';
import { ConfirmDialog } from '../../shell';
import { TaskEditorDialog, openMilestones } from './task-editor';

type Task = BacklogView['tasks'][number];
type Dialog = 'edit' | 'delete' | 'skip' | null;

/** The actions of one task row: a task without a run is edited, run, moved and deleted; a started one is opened or skipped. */
export function TaskMenu({
  view,
  task,
  owner,
  onView,
}: {
  view: BacklogView;
  task: Task;
  owner: boolean;
  onView: (view: BacklogView) => void;
}): ReactElement {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [moving, setMoving] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [refusal, setRefusal] = useState('');
  const active = view.milestones.find((item) => item.status === 'active');
  const close = (): void => {
    setAnchor(null);
    setMoving(false);
  };
  const act = (call: () => Promise<BacklogView>): void => {
    close();
    setRefusal('');
    call().then(onView, (error: unknown) =>
      setRefusal(error instanceof Error ? error.message : 'The action was refused.'),
    );
  };
  const targets = openMilestones(view).filter((item) => item.number !== task.milestone);
  const edit = (): void => {
    close();
    setDialog('edit');
  };
  const ask = (which: Dialog) => (): void => {
    close();
    setDialog(which);
  };
  const moveItems = [
    ...(task.milestone === null
      ? []
      : [
          <MenuItem key="none" onClick={() => act(() => changeBacklogTask(view.name, task.slug, { milestone: null }))}>
            Backlog items
          </MenuItem>,
        ]),
    ...targets.map((item) => (
      <MenuItem
        key={item.number}
        onClick={() => act(() => changeBacklogTask(view.name, task.slug, { milestone: item.number }))}
      >
        {`M${item.number} · ${item.title}`}
      </MenuItem>
    )),
  ];
  const startedItems = [
    <MenuItem key="open" component={Link} href={`/runs/${task.runKey}` as Route} onClick={close}>
      Open run
    </MenuItem>,
    <MenuItem key="skip" onClick={ask('skip')}>
      Skip
    </MenuItem>,
  ];
  const idleItems = [
    <MenuItem key="edit" onClick={edit}>
      Edit
    </MenuItem>,
    ...(owner && task.milestone !== active?.number
      ? [
          <MenuItem key="run" onClick={() => act(() => runBacklogTaskNow(view.name, task.slug))}>
            Run now
          </MenuItem>,
        ]
      : []),
    <MenuItem key="move" onClick={() => setMoving(true)}>
      Move to
    </MenuItem>,
    <MenuItem key="delete" onClick={ask('delete')}>
      Delete
    </MenuItem>,
  ];
  return (
    <>
      <IconButton
        size="small"
        aria-label={`Actions for ${task.title}`}
        onClick={(event) => setAnchor(event.currentTarget)}
      >
        <MoreVert fontSize="small" />
      </IconButton>
      <Menu anchorEl={anchor} open={anchor !== null} onClose={close}>
        {moving ? moveItems : task.runKey !== null ? startedItems : idleItems}
      </Menu>
      {dialog === 'edit' ? (
        <TaskEditorDialog
          view={view}
          task={task}
          milestone={task.milestone}
          onView={onView}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'delete' ? (
        <ConfirmDialog
          open
          title={`Delete ${task.title}?`}
          body="The task is removed from the backlog."
          verb="Delete task"
          tone="danger"
          onConfirm={async () => onView(await deleteBacklogTask(view.name, task.slug))}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'skip' ? (
        <ConfirmDialog
          open
          title={`Skip ${task.title}?`}
          body="The task is not done and the milestone goes on without it."
          verb="Skip task"
          tone="danger"
          onConfirm={async () => onView(await skipBacklogTask(view.name, task.slug))}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {refusal !== '' ? (
        <Typography role="alert" variant="caption" color="error" sx={{ display: 'block' }}>
          {refusal}
        </Typography>
      ) : null}
    </>
  );
}
