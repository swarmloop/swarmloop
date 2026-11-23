import { Injectable } from '@nestjs/common';
import type { TurnAnswer } from '../../../agent-result/definitions/backlog-turn';
import { SwarmloopError } from '../../../core/swarmloop-error';

/** A command the planner sends to a run, as a person sends it from the run's page. */
export type PlannerRunCommand =
  | { type: 'answer'; run: string; answers: TurnAnswer[] }
  | { type: 'resume'; run: string }
  | { type: 'replay'; run: string; step: string }
  | { type: 'skipTask'; run: string; task: string }
  | { type: 'stop'; run: string }
  | { type: 'planChat'; run: string; message: string }
  | { type: 'passOn'; run: string; question?: string; line: string };

type PlannerRunSender = (command: PlannerRunCommand, owner: string, key: string) => Promise<void>;

/** The planner's way into a run. The API layer registers the sender, so the pipeline layer does not import it. */
@Injectable()
export class PlannerRunPort {
  private sender: PlannerRunSender | null = null;

  register(sender: PlannerRunSender): void {
    this.sender = sender;
  }

  /** Sends the command as the owner of the backlog; the same key sent twice runs the command once. */
  send(command: PlannerRunCommand, owner: string, key: string): Promise<void> {
    if (!this.sender) {
      return Promise.reject(new SwarmloopError('the server cannot send a command to a run here'));
    }
    return this.sender(command, owner, key);
  }
}
