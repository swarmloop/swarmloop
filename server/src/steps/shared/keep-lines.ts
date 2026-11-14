/** One capability of a split plan that must keep working, and the tasks that touch it. */
export interface KeepLine {
  capability: string;
  /** The test that proves it, or `new <test>` when the first named task writes it. */
  proof: string;
  tasks: string[];
}

/** Every defect of the keep lines of a split answer: a line that names no task, or a task that is not in the list. */
export function keepErrors(lines: KeepLine[], taskIds: string[]): string[] {
  return lines.flatMap((line) => {
    if (line.tasks.length === 0) {
      return [`keep line names no task: ${line.capability}`];
    }
    return line.tasks
      .filter((id) => !taskIds.includes(id))
      .map((id) => `keep line names unknown task ${id}: ${line.capability}`);
  });
}

/** The lines that name one task. */
export function keepFor(lines: KeepLine[], taskId: string): KeepLine[] {
  return lines.filter((line) => line.tasks.includes(taskId));
}

/** One bullet per line: the capability and its proof test. */
export function renderKeep(lines: KeepLine[]): string {
  return lines.map((line) => `- ${line.capability} (proof: ${line.proof})`).join('\n');
}
