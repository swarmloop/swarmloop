import { join } from 'path';
import { Logger } from '@nestjs/common';
import { agentFor } from '../config/agents';
import type { AppConfig } from '../config/env';
import { resumableChat } from '../agent/agent-session';
import { visitStatus } from '../core/pipeline-result';
import { SwarmloopError } from '../core/swarmloop-error';
import type { Clock } from '../core/clock';
import { mountsForStep, repoNames } from '../git/repo-names';
import { root } from '../history/run-paths';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { RunEntity } from '../history/entities';
import type { Subtask } from '../contract/subtask';
import type { DocumentRepository } from '../history/document.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { LaunchResult } from '../steps/shared/result-exchange';
import type { AgentLauncher } from '../steps/shared/agent-launcher';
import { agentFailure } from '../steps/shared/agent-result';
import { openQuestions, unanswered } from '../steps/shared/answers';
import { storedAsks } from './stored-research';
import { modelVisit } from '../steps/shared/model-visit';
import { StepStopped } from '../steps/shared/step-stopped';
import { DECIDE_YOURSELF, subtaskAsks } from '../steps/plan/plan.prompts';
import { subtaskAnswer, type SubtaskAnswerResult } from '../agent-result/definitions/subtask-answer';
import type { OpenedStep } from '../steps/step-run';
import type { CommandService } from './command.service';

/** The parent planner's answer to the questions of a subtask's research. */
export class SubtaskPlannerAnswer {
  private readonly logger = new Logger(SubtaskPlannerAnswer.name);
  /** The planner's reply per subtask run whose delivery was refused, so a retry sends it again and does not ask again. */
  private readonly undelivered = new Map<string, string | null>();
  /** The plan visits of a parent when its planner last answered a subtask. A new plan visit makes the next prompt full. */
  private readonly answeredAt = new Map<string, number>();

  constructor(
    private readonly documents: DocumentRepository,
    private readonly commands: CommandService,
    private readonly launcher: AgentLauncher,
    private readonly visits: VisitRepository,
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  async asking(run: RunEntity): Promise<boolean> {
    if (run.status !== 'waiting' || run.currentStep !== 'research') return false;
    const questions = (await this.documents.latestBody(run.key, ARTIFACTS.questions.kind)) ?? '';
    const answers = (await this.documents.latestBody(run.key, ARTIFACTS.answers.kind)) ?? '';
    return unanswered(questions, await storedAsks(this.documents, run.key), answers).length > 0;
  }

  async answer(opened: OpenedStep, child: RunEntity, task: Subtask, contract: string): Promise<string | null> {
    const questions = (await this.documents.latestBody(child.key, ARTIFACTS.questions.kind)) ?? '';
    const answer = this.undelivered.has(child.key)
      ? (this.undelivered.get(child.key) ?? null)
      : await this.askAbout(opened, task, questions, contract);
    const text = answer ?? DECIDE_YOURSELF;
    const answers = openQuestions(questions, await storedAsks(this.documents, child.key)).map((id) => ({
      kind: 'question',
      id,
      body: text,
    }));
    try {
      await this.commands.submit(
        'answer',
        child.key,
        { answers },
        { idempotencyKey: `subtask-answer-${child.key}-${child.revision}` },
      );
    } catch (error) {
      this.undelivered.set(child.key, answer);
      this.logger.warn(`${child.key} was not answered: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
    this.undelivered.delete(child.key);
    return answer;
  }

  /**
   * A follow-up visit of the plan step in the chat of the parent, recorded like any visit of that step. The pass
   * already holds the parent, so nothing else uses the chat meanwhile. Null when the planner gave no usable answer.
   */
  async askAbout(opened: OpenedStep, task: Subtask, questions: string, contract: string): Promise<string | null> {
    const parent = opened.run;
    const env = this.config.env;
    const { runtime, model, ...effort } = agentFor(env, parent, 'plan');
    const dir = root(this.config);
    if (!(await resumableChat(dir, parent.key, 'plan', runtime))?.chatId) return null;
    const planVisits = async (): Promise<number> =>
      (await this.visits.listStats(parent.id)).filter((stat) => stat.step === 'plan').length;
    const received = this.answeredAt.get(parent.key) === (await planVisits()) ? subtaskAnswer.name : null;
    const prompt = subtaskAsks(task, questions, contract, received);
    let result: LaunchResult | null = null;
    let failure: string | null = null;
    try {
      const names = repoNames((await this.documents.latestBody(parent.key, ARTIFACTS.repos.kind)) ?? '');
      result = await this.launcher.launch({
        root: dir,
        run: parent,
        key: parent.key,
        step: 'plan',
        mode: 'plan',
        tools: 'plan',
        runtime,
        model,
        ...effort,
        timeLimitMs: env.PLAN_TIMEOUT_MS,
        prompt,
        result: subtaskAnswer,
        workspace: join(dir, 'worktrees', parent.key),
        mounts: mountsForStep(dir, parent.key, names, parent.targetPath),
      });
      failure = agentFailure(result, 'plan', 'plan');
    } catch (error) {
      if (error instanceof StepStopped) throw error;
      failure = error instanceof SwarmloopError ? error.message : 'plan failed';
    }
    const given = failure ? null : (result?.resultValue as SubtaskAnswerResult | undefined);
    const answer = (given?.answer ?? '').trim();
    await this.visits.finishVisit(
      parent,
      modelVisit({
        opened,
        now: this.clock.now(),
        step: 'plan',
        mode: 'plan',
        runtime,
        model,
        ...effort,
        agent: result,
        prompt,
        status: visitStatus(answer ? 'ok' : 'failed'),
        exitCode: answer ? 0 : 1,
      }),
    );
    if (result) {
      this.answeredAt.set(parent.key, await planVisits());
    }
    if (given && answer) {
      await this.documents.putDocument(
        parent,
        ARTIFACTS.subtaskAnswerResult.kind,
        ARTIFACTS.subtaskAnswerResult.format(given),
      );
    }
    return answer || null;
  }
}
