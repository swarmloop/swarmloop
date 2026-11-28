import type { LimitHit, LimitInput } from '../integrations/agent-runtime/runtime-limit';
import type { ModelHostOutage } from '../integrations/agent-runtime/runtime-outage';
import type { AgentRuntime } from '../integrations/agent-runtime/agent-runtime';

/** How much of the end of stderr is kept to read a limit from. */
const STDERR_CHARS = 4_000;

/** The end of a launch's output: its last stdout line and its stderr, where a provider's limit or outage text shows. */
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
    return runtime.classifyLimit(this.end(partial, now));
  }

  /** The outage of the model host the launch ended on, or null. Read from the same end as the limit. */
  outage(runtime: AgentRuntime, partial: string, now: number): ModelHostOutage | null {
    return runtime.classifyOutage(this.end(partial, now));
  }

  /**
   * What the launch ended on besides an answer: its usage limit, else the outage of its model host. A limit goes to failover, so it hides an outage.
   * `paidUse` is the limit a stream line said, which the launch was ended on: it is the limit, with no reading of the end.
   */
  ending(
    runtime: AgentRuntime,
    partial: string,
    now: number,
    paidUse: LimitHit | null = null,
  ): { limit?: LimitHit; outage?: ModelHostOutage } {
    const limit = paidUse ?? this.limit(runtime, partial, now);
    if (limit) {
      return { limit };
    }
    const outage = this.outage(runtime, partial, now);
    return outage ? { outage } : {};
  }

  private end(partial: string, now: number): LimitInput {
    return { finalLine: partial.trim() === '' ? this.finalLine : partial, stderr: this.stderr, now };
  }
}
