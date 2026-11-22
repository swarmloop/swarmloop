import type { CommandEntity } from '../history/entities';
import type { SubtaskStart } from '../steps/shared/subtask-ops';

/** The mark a person's Resume carries in its payload: the HTTP route and the CLI add it, the server's own resumes do not. */
export const PERSON_RESUME = { by: 'person' } as const;

/** Whether the command is a Resume that a person sent. Unreadable payloads are not. */
export function isPersonResume(command: Pick<CommandEntity, 'type' | 'payload'>): boolean {
  if (command.type !== 'resume') return false;
  try {
    return (JSON.parse(command.payload) as { by?: unknown } | null)?.by === PERSON_RESUME.by;
  } catch {
    return false;
  }
}

/** Reads who sent a Resume from its payload. A missing, unknown or unreadable `by` is the machine. */
export function startByOf(command: Pick<CommandEntity, 'payload'>): SubtaskStart {
  try {
    const payload = JSON.parse(command.payload) as { by?: unknown; level?: unknown } | null;
    if (payload?.by === 'person') return { by: 'person', level: null };
    if (payload?.by === 'planner') {
      return { by: 'planner', level: typeof payload.level === 'number' ? payload.level : null };
    }
  } catch {
    // An unreadable payload is a machine's.
  }
  return { by: 'machine', level: null };
}
