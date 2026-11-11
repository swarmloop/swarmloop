import type { Subtask } from '../contract/subtask';

/** The prompt of a subtask: its task, the parent's requirements as context, and the branch it starts from. */
export function subtaskPrompt(task: Subtask, brief: string, branch: string): string {
  return [
    `${task.title}\n\n${task.description}`,
    `files: ${task.files.join(', ')}`,
    `proof: ${task.proof}`,
    `Requirements of the parent run, for context:\n${brief.trimEnd()}`,
    `branch: ${branch}`,
  ].join('\n\n');
}
