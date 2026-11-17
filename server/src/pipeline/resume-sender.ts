import type { CommandEntity } from '../history/entities';

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
