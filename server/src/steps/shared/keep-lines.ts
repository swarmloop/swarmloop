import { SwarmloopError } from '../../core/swarmloop-error';

/** One capability of a split plan that must keep working, and the tasks that touch it. */
export interface KeepLine {
  capability: string;
  /** The test that proves it, or `new <test>` when the first named task writes it. */
  proof: string;
  tasks: string[];
}

/** The lines of a split answer's `keep:` section. A missing section or `none` is no line. */
export function parseKeep(block: string | null, taskIds: string[]): KeepLine[] {
  const lines = (block ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== '-' && !/^-?\s*none$/i.test(line));
  return lines.map((line) => keepLineOf(line, taskIds));
}

function keepLineOf(line: string, taskIds: string[]): KeepLine {
  const [capability = '', proof = '', named = ''] = line
    .replace(/^-\s*/, '')
    .split('|')
    .map((part) => part.trim());
  if (!capability || !proof.startsWith('proof:') || !named.startsWith('tasks:')) {
    throw new SwarmloopError(`keep line is malformed: ${line}`);
  }
  const tasks = named
    .slice('tasks:'.length)
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id && id !== 'none');
  if (tasks.length === 0) {
    throw new SwarmloopError(`keep line names no task: ${capability}`);
  }
  const unknown = tasks.find((id) => !taskIds.includes(id));
  if (unknown) {
    throw new SwarmloopError(`keep line names unknown task ${unknown}: ${capability}`);
  }
  return { capability, proof: proof.slice('proof:'.length).trim(), tasks };
}

/** The lines that name one task. */
export function keepFor(lines: KeepLine[], taskId: string): KeepLine[] {
  return lines.filter((line) => line.tasks.includes(taskId));
}

/** One bullet per line: the capability and its proof test. */
export function renderKeep(lines: KeepLine[]): string {
  return lines.map((line) => `- ${line.capability} (proof: ${line.proof})`).join('\n');
}
