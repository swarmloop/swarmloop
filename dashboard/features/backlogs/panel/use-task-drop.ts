import { useState, type DragEvent } from 'react';
import type { BacklogView } from '@contract/backlog';
import { changeBacklogTask } from '../../../lib/backlog-endpoints';

const DRAG_TYPE = 'text/task-slug';

interface DropTarget {
  onDragOver: (event: DragEvent) => void;
  onDrop: (event: DragEvent) => void;
}

/** Native drag of a task between milestone lists and the backlog items; `milestone` is the list's own number or null. */
export function useTaskDrop(
  backlog: string,
  milestone: number | null,
  onView: (view: BacklogView) => void,
): { target: DropTarget; refusal: string } {
  const [refusal, setRefusal] = useState('');
  const target: DropTarget = {
    onDragOver: (event) => event.preventDefault(),
    onDrop: (event) => {
      event.preventDefault();
      const slug = event.dataTransfer.getData(DRAG_TYPE);
      if (slug === '') {
        return;
      }
      setRefusal('');
      changeBacklogTask(backlog, slug, { milestone }).then(onView, (error: unknown) =>
        setRefusal(error instanceof Error ? error.message : 'The move was refused.'),
      );
    },
  };
  return { target, refusal };
}

/** Props that make a row of a task without a run draggable. */
export function taskDragProps(slug: string): {
  draggable: true;
  onDragStart: (event: DragEvent) => void;
} {
  return {
    draggable: true,
    onDragStart: (event) => {
      event.dataTransfer.setData(DRAG_TYPE, slug);
      event.dataTransfer.effectAllowed = 'move';
    },
  };
}
