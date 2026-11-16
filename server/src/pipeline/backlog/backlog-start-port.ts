import { Injectable } from '@nestjs/common';
import { SwarmloopError } from '../../core/swarmloop-error';

/** What the scheduler asks for when it starts a task: a run like the one New run makes. */
export interface BacklogStart {
  key: string;
  prompt: string;
  projects: string[];
  /** The person the run is started for. */
  owner: string;
}

type BacklogStartFunction = (start: BacklogStart) => Promise<void>;

/** The start of a task's run. The API layer registers the function, so the pipeline layer does not import it. */
@Injectable()
export class BacklogStartPort {
  private starter: BacklogStartFunction | null = null;

  register(starter: BacklogStartFunction): void {
    this.starter = starter;
  }

  start(start: BacklogStart): Promise<void> {
    if (!this.starter) {
      return Promise.reject(new SwarmloopError('the server cannot start a backlog task here'));
    }
    return this.starter(start);
  }
}
