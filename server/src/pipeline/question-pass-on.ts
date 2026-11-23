import { ConflictException, Injectable } from '@nestjs/common';
import { Clock } from '../core/clock';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { QuestionHolds, readPassedOn } from '../steps/shared/question-holds';
import { releaseAsked } from './escalation';

/** Passes the questions of a backlog's run that its planner holds on to the person, each with the planner's line. */
@Injectable()
export class QuestionPassOn {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly runs: RunRepository,
    private readonly holds: QuestionHolds,
    private readonly clock: Clock,
  ) {}

  /**
   * Passes the question named, or every question the planner holds on the run when none is named. A question already
   * passed on or answered is not held and is skipped. The run then waits for the person. Returns the questions passed.
   */
  async pass(runKey: string, question: string | undefined, line: string): Promise<string[]> {
    const run = await this.runs.findRun(runKey);
    if (!run) return [];
    const held = (await this.holds.held(run)).filter((item) => question === undefined || item.id === question);
    if (held.length === 0) return [];
    const passed = readPassedOn(await this.documents.latestBody(run.key, ARTIFACTS.passedOn.kind));
    const at = this.clock.iso();
    await this.documents.putDocument(
      run,
      ARTIFACTS.passedOn.kind,
      ARTIFACTS.passedOn.format([...passed, ...held.map((item) => ({ question: item.id, line, at }))]),
    );
    await releaseAsked(this.runs, this.holds, run.key);
    return held.map((item) => item.id);
  }

  /** The planner's action: passes the question and refuses, as a run command does, when the planner holds none. */
  async passOrRefuse(runKey: string, question: string | undefined, line: string): Promise<void> {
    if ((await this.pass(runKey, question, line)).length === 0) {
      throw new ConflictException(`${runKey} has no question that waits for the planner`);
    }
  }
}
