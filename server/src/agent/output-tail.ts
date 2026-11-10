import type { LimitHit } from '../integrations/agent-runtime/runtime-limit';
import type { AgentRuntime } from '../integrations/agent-runtime/agent-runtime';

/** How much of the end of stderr is kept to read a limit from. */
const STDERR_CHARS = 4_000;

/** The end of a launch's output: its last stdout line and its stderr, where a provider's limit text shows. */
export class OutputTail {
  private finalLine = '';
  private stderr = '';

  stdout(line: string): void {
    this.finalLine = line.trim() === '' ? this.finalLine : line;
  }

  error(chunk: string): void {
    this.stderr = (this.stderr + chunk).slice(-STDERR_CHARS);
  }

  /** The limit the launch ended on, or null. `partial` is the stdout line that never got its newline. */
  limit(runtime: AgentRuntime, partial: string, now: number): LimitHit | null {
    return runtime.classifyLimit({
      finalLine: partial.trim() === '' ? this.finalLine : partial,
      stderr: this.stderr,
      now,
    });
  }
}
