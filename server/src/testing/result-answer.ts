import { emptyResult } from '../agent/agent-result';
import type { AgentRunResult } from '../agent/agent-result';

const FENCE = '```';

/** The final text of an agent that ends with its result block: prose for people, a blank line, then the block. */
export function resultAnswer(prose: string, value: unknown): string {
  return `${prose}\n\n${FENCE}json\n${JSON.stringify(value)}\n${FENCE}`;
}

/** One answer of a script: a value that becomes a result block, or the raw text of the answer. */
export type ScriptedAnswer = { block: unknown; prose?: string } | { text: string };

function textOf(answer: ScriptedAnswer): string {
  return 'text' in answer ? answer.text : resultAnswer(answer.prose ?? 'Done.', answer.block);
}

/**
 * A fake `AGENT_RUNNER` that answers every launch with a result block. It records the steps it ran, like
 * `ScriptedFakeAgentRunner`, and the prompt of each launch. A step's script is answered in order, then the step's
 * default value is answered for every later launch, so a spec scripts only the answers it cares about.
 */
export class BlockAgentRunner {
  readonly steps: string[] = [];
  readonly prompts: { step: string; prompt: string; freshPrompt?: string }[] = [];
  private readonly scripts: Map<string, ScriptedAnswer[]>;

  constructor(
    scripts: Record<string, ScriptedAnswer[]> = {},
    private readonly defaults: Record<string, unknown> = {},
  ) {
    this.scripts = new Map(Object.entries(scripts).map(([step, answers]) => [step, [...answers]]));
  }

  run(input: { step: string; prompt?: string; freshPrompt?: string }): Promise<AgentRunResult> {
    this.steps.push(input.step);
    this.prompts.push({ step: input.step, prompt: input.prompt ?? '', freshPrompt: input.freshPrompt });
    const next = this.scripts.get(input.step)?.shift();
    const answer = next ?? { block: this.defaults[input.step] ?? {} };
    const now = new Date(0).toISOString();
    return Promise.resolve({
      ...emptyResult('time', 0, 1, now),
      killReason: null,
      tokensIn: 10,
      tokensOut: 5,
      responseText: textOf(answer),
    });
  }
}
