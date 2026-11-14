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

/** The first pass of an implement step that was asked for nothing in particular. */
const DEFAULT_IMPLEMENT = { implementation: ['changed the field'], summary: ['implemented the plan'] };

/** The second pass leaves the first one as it was. */
const DEFAULT_IMPLEMENT_IMPROVE = { summary: ['checked the first pass'] };

/** An agent that resolved the conflict of a rebase. */
const DEFAULT_REBASE = { summary: ['resolved the rebase'] };

const DEFAULT_ANSWERS: Record<string, unknown> = {
  research: DEFAULT_RESEARCH,
  plan: DEFAULT_PLAN,
  'plan-improve': DEFAULT_PLAN_IMPROVE,
  implement: DEFAULT_IMPLEMENT,
  'implement-improve': DEFAULT_IMPLEMENT_IMPROVE,
  rebase: DEFAULT_REBASE,
};

/** The final text of an agent that ends with its result block: prose for people, a blank line, then the block. */
export function resultAnswer(prose: string, value: unknown): string {
  return `${prose}\n\n${FENCE}json\n${JSON.stringify(value)}\n${FENCE}`;
}

/** The script a launch belongs to: a conflict resolution is the implement step's agent, and has its own script, `rebase`. */
function scriptOf(input: { step: string; prompt?: string }): string {
  return input.step === 'implement' && input.prompt?.includes('The commit being replayed is') ? 'rebase' : input.step;
}

/** One answer of a script: a value that becomes a result block, or the raw text of the answer. */
export type ScriptedAnswer = { block: unknown; prose?: string } | { text: string };

function textOf(answer: ScriptedAnswer): string {
  return 'text' in answer ? answer.text : resultAnswer(answer.prose ?? 'Done.', answer.block);
}

/**
 * A fake `AGENT_RUNNER` that answers every launch with a result block. It records the steps it ran, like
 * `ScriptedFakeAgentRunner`, and the prompt of each launch. A step's script is answered in order, then the step's
 * default value (every step that has one: research, plan, plan-improve, implement, implement-improve and rebase) is answered for every later launch, so a spec scripts only the answers it cares about.
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
    const script = scriptOf(input);
    this.steps.push(script);
    this.prompts.push({ step: script, prompt: input.prompt ?? '', freshPrompt: input.freshPrompt });
    const next = this.scripts.get(script)?.shift();
    const answer = next ?? { block: this.defaults[script] ?? {} };
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
