import { emptyResult } from '../agent/agent-result';
import type { AgentRunResult } from '../agent/agent-result';

const FENCE = '```';

/** The research result of a run with nothing to ask, nothing at stake and no sibling to wait for. */
export const DEFAULT_RESEARCH = { summary: ['researched the change'], questions: [], impact: [] };

/** The plan of a run that does not split and asks no one. */
const DEFAULT_PLAN = {
  summary: ['planned the change'],
  plan: ['do the change - files: a.ts - proof: a.spec.ts'],
};

/** The review of that plan: it keeps the plan. */
const DEFAULT_PLAN_IMPROVE = { summary: ['checked the plan'], plan: [] };

const DEFAULT_ANSWERS: Record<string, unknown> = {
  research: DEFAULT_RESEARCH,
  plan: DEFAULT_PLAN,
  'plan-improve': DEFAULT_PLAN_IMPROVE,
};

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
 * default value (research, plan and plan-improve have one) is answered for every later launch, so a spec scripts only the answers it cares about.
 */
export class BlockAgentRunner {
  readonly steps: string[] = [];
  readonly prompts: { step: string; prompt: string; freshPrompt?: string }[] = [];
  private readonly scripts: Map<string, ScriptedAnswer[]>;
  private readonly defaults: Record<string, unknown>;

  constructor(scripts: Record<string, ScriptedAnswer[]> = {}, defaults: Record<string, unknown> = {}) {
    this.defaults = { ...DEFAULT_ANSWERS, ...defaults };
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
