import type { AppConfig } from '../config/env';
import type { Clock } from '../core/clock';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { AgentLauncher } from '../steps/shared/agent-launcher';
import type { OpenedStep } from '../steps/step-run';
import type { Subtask } from '../contract/subtask';
import type { CommandService } from './command.service';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { mergeHandoff } from '../steps/shared/handoff';
import { storedNeeds, type Need } from '../steps/shared/needs';
import { storedAsks } from './stored-research';
import { SubtaskPlannerAnswer } from './subtask-planner-answer';

/** The asks of subtask runs and the answers they get, as the port hands them to the implement pass. */
export class SubtaskAsks {
  private readonly planner: SubtaskPlannerAnswer;

  constructor(
    private readonly documents: DocumentRepository,
    private readonly commands: CommandService,
    launcher: AgentLauncher,
    private readonly visits: VisitRepository,
    config: AppConfig,
    clock: Clock,
  ) {
    this.planner = new SubtaskPlannerAnswer(documents, commands, launcher, visits, config, clock);
  }

  asking(run: RunEntity): Promise<boolean> {
    return this.planner.asking(run);
  }

  answer(opened: OpenedStep, child: RunEntity, task: Subtask, contract: string): Promise<string | null> {
    return this.planner.answer(opened, child, task, contract);
  }

  replyPending(child: RunEntity): boolean {
    return this.planner.replyPending(child);
  }

  deliverAnswer(child: RunEntity, text: string): Promise<void> {
    return this.planner.deliver(child, text);
  }

  askAbout(opened: OpenedStep, task: Subtask, questions: string, contract: string): Promise<string | null> {
    return this.planner.askAbout(opened, task, questions, contract);
  }

  /** The needs a subtask run waits on, with the questions it asked. */
  async needsOf(run: RunEntity): Promise<Need[]> {
    return storedNeeds(
      (await this.documents.latestBody(run.key, ARTIFACTS.needs.kind)) ?? '',
      await storedAsks(this.documents, run.key),
    );
  }

  /** Hands the answers to the needs back to the run and resumes it; a refused resume puts the needs back. */
  async rerun(run: RunEntity, lines: string[]): Promise<void> {
    const needs = await this.documents.latestBody(run.key, ARTIFACTS.needs.kind);
    const handoff = await this.documents.latestBody(run.key, ARTIFACTS.handoff.kind);
    await this.documents.putDocument(run, ARTIFACTS.needs.kind, '');
    await this.documents.putDocument(
      run,
      ARTIFACTS.handoff.kind,
      mergeHandoff(handoff, run.currentStep, lines.join('\n')),
    );
    try {
      await this.commands.accept(
        'resume',
        run.key,
        {},
        { idempotencyKey: `subtask-needs-${run.key}-${(await this.visits.listStats(run.id)).length}` },
      );
    } catch (error) {
      await this.documents.putDocument(run, ARTIFACTS.needs.kind, needs ?? '');
      throw error;
    }
  }
}
