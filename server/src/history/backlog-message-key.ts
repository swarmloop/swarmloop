/**
 * The key under which the files of a backlog's messages are kept. The dots keep it out of every run key
 * pattern, so no run can be started with it and reach these files.
 */
export function backlogMessageKey(backlogId: number): string {
  return `backlog.${backlogId}.messages`;
}
