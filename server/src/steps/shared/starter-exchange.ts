import type { Clock } from '../../core/clock';
import type { PlanChatStore } from '../../history/plan-chat.store';
import type { RunEntity } from '../../history/entities';
import { REASON } from '../../contract/run-state';
import { isSubtask } from '../../contract/subtask';
import type { Need } from '../../agent-result/definitions/research';
import type { OutOfScope, StarterDecision } from '../../agent-result/definitions/starter-fields';
import { ARTIFACTS } from '../contract/artifacts';
import type { StepResult } from '../contract/step-contract';
import type { ModelStepContext } from '../model-step-context';
import { waitForPlanner } from '../implement/implement-question';
import { renderQuestions } from '../research/research-record';
import { readContract } from './contract-items';
import { needsWait } from './needs';
import { handBackLine } from './hand-back';

/** What a subtask's result hands to the run that started it, beside its own result. */
interface StarterFields {
  needs?: Need[];
  question?: string;
  decisions?: StarterDecision[];
  outOfScope?: OutOfScope[];
}

/** One visit of a step that may act on what its result handed back. */
interface StarterVisit {
  step: string;
  /** `document`: a question waits in the step's questions document (research, plan). `chat`: it goes to the planner's chat (implement, implement-improve). */
  route: 'document' | 'chat';
  /** An answer was read in this visit: a further question is decided by the step and recorded as an assumption. */
  answered: boolean;
  /** Whether there is a planner to ask. */
  mayAsk: boolean;
  /** What a wait carries besides its own outputs: the step's result. */
  outputs: StepResult['outputs'];
  /** The same for a wait on `needs`, when it differs. */
  needsOutputs?: StepResult['outputs'];
}

/** What acting left: the result of a step that waits, or the choices the step made itself, as the lines of its assumptions. */
export interface StarterOutcome {
  wait: StepResult | null;
  assumed: string[];
}

/** The words a subtask waits with while the planner of its parent has what it asked. */
export function asksParentReason(step: string): string {
  return `${step} asks the planner of the parent`;
}

/**
 * The one place that acts on what a subtask's result hands back: `needs`, `question`, `decisions` and `outOfScope`.
 * A step passes its result; a wait is a result of the step with nothing committed and no container held.
 */
export class StarterExchange {
  constructor(
    private readonly chat: PlanChatStore | undefined,
    private readonly clock: Clock,
  ) {}

  /**
   * What the server checks on the decisions of an answer: a subtask decides about the items it owns, and a choice
   * about an item another task owns goes up as `question`.
   */
  check(run: RunEntity, value: StarterFields, contract: string | null): string[] {
    if (!isSubtask(run) || !value.decisions?.length) return [];
    const { items } = readContract(contract ?? '');
    return value.decisions.flatMap(({ item }) => {
      const owner = items.find((entry) => entry.id === item)?.owner;
      return owner && owner !== run.taskId ? [`decisions: ${item} is owned by ${owner}; send it as question`] : [];
    });
  }

  async act(ctx: ModelStepContext, fields: StarterFields, visit: StarterVisit): Promise<StarterOutcome> {
    const { run, startedAt, attemptId } = ctx.opened;
    const subtask = isSubtask(run);
    const needs = subtask ? (fields.needs ?? []) : [];
    if (needs.length > 0) {
      const wait = needsWait(startedAt, needs);
      return { wait: { ...wait, outputs: [...wait.outputs, ...(visit.needsOutputs ?? visit.outputs)] }, assumed: [] };
    }
    await this.report(ctx, visit.step, fields);
    const question = fields.question?.trim() ?? '';
    const handBacks = this.handBacks(fields);
    // A need of a run that is not a subtask names no task: it is a question for the planner.
    const needLines = subtask ? [] : (fields.needs ?? []).flatMap(({ what }) => (what.trim() ? [what.trim()] : []));
    const asked = [...(question ? [question] : []), ...needLines, ...handBacks];
    if (asked.length === 0) return { wait: null, assumed: [] };
    if (visit.answered || (visit.route === 'chat' && !this.chat)) return { wait: null, assumed: asked };
    if (visit.route === 'document') {
      const body = renderQuestions(asked);
      return {
        wait: {
          route: { to: 'wait', reason: 'questions are open' },
          summary: `${startedAt} ${visit.step} waiting\n${body.trimEnd()}`,
          outputs: [{ artifact: ARTIFACTS.questions, value: body }, ...visit.outputs],
        },
        assumed: [],
      };
    }
    if (handBacks.length === 0) {
      if (!visit.mayAsk || !this.chat) return { wait: null, assumed: asked };
      const ask = { chat: this.chat, clock: this.clock, step: visit.step, attemptId, startedAt };
      const text = [...(question ? [question] : []), ...needLines].join('\n');
      return { wait: await waitForPlanner(run, { ...ask, question: text }), assumed: [] };
    }
    return { wait: await this.askParent(ctx, visit, asked), assumed: [] };
  }

  /**
   * Hands what the step leaves out to the starter, like a question of that step: one pending escalation per entry
   * in the run's own chat, which the planner of the parent finds. The run waits and no container is held.
   */
  private async askParent(ctx: ModelStepContext, visit: StarterVisit, texts: string[]): Promise<StepResult> {
    const { startedAt } = ctx.opened;
    await this.escalateFor(ctx.opened.run, visit.step, ctx.opened.attemptId, texts);
    const reason = `${asksParentReason(visit.step)}: ${texts.join('; ')}`;
    return {
      route: { to: 'wait', code: REASON.asksPlanner, reason },
      summary: `${startedAt} ${reason}\n${texts.join('\n')}`,
      outputs: visit.outputs,
    };
  }

  /** The parts the result leaves out, as the lines a planner is asked. */
  private handBacks(fields: StarterFields): string[] {
    return (fields.outOfScope ?? []).map(handBackLine);
  }

  /**
   * Hands what a reply leaves to the starter without making the run wait: the decisions and parts left out are
   * reported, and the question, the parts and the `more` texts are pending escalations in the run's own chat that the
   * planner of the parent finds.
   */
  async handUp(ctx: ModelStepContext, fields: StarterFields, step: string, more: string[] = []): Promise<void> {
    await this.report(ctx, step, fields);
    const question = fields.question?.trim() ?? '';
    await this.escalateFor(ctx.opened.run, step, ctx.opened.attemptId, [
      ...(question ? [question] : []),
      ...more,
      ...this.handBacks(fields),
    ]);
  }

  /** One pending escalation per text in the run's chat, named by the step and the event, so a replay writes each once. */
  async escalateFor(run: Pick<RunEntity, 'key'>, step: string, event: string, texts: string[]): Promise<void> {
    for (const [index, text] of texts.entries()) {
      await this.chat?.appendEntry(run.key, {
        key: `handback-${step}-${event}-${index}`,
        role: 'planner',
        kind: 'escalation',
        from: step,
        text,
        at: this.clock.iso(),
        state: 'pending',
      });
    }
  }

  /** The decisions and the parts left out of the visit, under the key of the attempt, so a replay of the attempt writes them once. */
  private async report(ctx: ModelStepContext, step: string, fields: StarterFields): Promise<void> {
    const decisions = fields.decisions ?? [];
    const outOfScope = fields.outOfScope ?? [];
    if (decisions.length === 0 && outOfScope.length === 0) return;
    const key = `${step}-${ctx.opened.attemptId}`;
    const stored = JSON.parse((await ctx.reread(ARTIFACTS.starterReport)) || '[]') as { key: string }[];
    const entries = [...stored.filter((entry) => entry.key !== key), { key, step, decisions, outOfScope }];
    await ctx.write(ARTIFACTS.starterReport, JSON.stringify(entries));
  }
}
