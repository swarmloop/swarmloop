import type { AgentRunInput } from '../agent/agent-runner';
import type { ContainerGate } from '../sandbox/container-gate';
import type { FakeAgentRunner } from './test-app';

/**
 * The agent process of a test app, as `SandboxService.spawn` gates it: every launch of a step takes a place in the
 * real `ContainerGate`, stays open until the spec lets it end, and gives the place back. A launch of a scripted step
 * names no run and is not an agent container. The peak is the most that ever ran at once; `waited` is every wait the
 * gate told. A launch answers nothing, so the real step reads its answer from the app's blocks.
 */
export class GatedAgents implements FakeAgentRunner {
  peak = 0;
  readonly steps: string[] = [];
  readonly waited: string[] = [];
  private gate: ContainerGate | undefined;
  private holding = true;
  private running = 0;
  private readonly ends: (() => void)[] = [];

  /** The gate the app admits its containers through: `app.app.get(ContainerGate)`. */
  through(gate: ContainerGate): void {
    this.gate = gate;
  }

  get open(): number {
    return this.running;
  }

  async run(step: string, input: AgentRunInput): Promise<undefined> {
    this.steps.push(step);
    const runKey = (input as Partial<AgentRunInput>).runKey;
    if (!this.gate || !runKey) return undefined;
    const release = await this.gate.admit(() => undefined, runKey, {
      step: input.liveStep ?? input.step,
      onWait: (text) => this.waited.push(text),
    });
    this.running += 1;
    this.peak = Math.max(this.peak, this.running);
    if (this.holding) await new Promise<void>((end) => this.ends.push(end));
    this.running -= 1;
    release();
    return undefined;
  }

  /** Lets the agent that has run the longest end. False when none runs. */
  endOldest(): boolean {
    const end = this.ends.shift();
    end?.();
    return end !== undefined;
  }

  /** Every open agent ends, and later launches end as soon as they run. */
  endAll(): void {
    this.holding = false;
    while (this.endOldest());
  }
}
