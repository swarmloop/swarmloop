import { Injectable } from '@nestjs/common';
import { REASON } from '../contract/run-state';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { CommandService } from './command.service';
import { PERSON_RESUME } from './resume-sender';

type StartBy = 'person' | 'planner' | 'machine';

interface StartRequest {
  by: StartBy;
  /** The idempotency key. It names the event the resume is for, never a counter that other writes move. */
  event: string;
  /** The level of the planner that asks. Set only with `by: 'planner'`. */
  level?: number;
  actor?: string | null;
  payload?: Record<string, unknown>;
}

/** The one door a resume of a run passes when the person's routes are not the caller. */
@Injectable()
export class StartGate {
  constructor(
    private readonly commands: CommandService,
    private readonly runs: RunRepository,
  ) {}

  /** Whether a person stopped the run. The run is read again, so a copy from before the Stop does not count. */
  async stopped(run: Pick<RunEntity, 'key'>): Promise<boolean> {
    const stored = await this.runs.findRun(run.key);
    return stored?.status === 'blocked' && storedState(stored).reason?.code === REASON.stopped;
  }

  /**
   * Resumes the run once per event. A run a person stopped is resumed only by a person, or by a planner that acts on a
   * person's message (its payload carries the person's mark); for the machine and any other planner it answers `stopped`.
   */
  async resume(run: Pick<RunEntity, 'key'>, request: StartRequest): Promise<'accepted' | 'replayed' | 'stopped'> {
    const personal = request.by === 'person' || request.payload?.by === PERSON_RESUME.by;
    if (!personal && (await this.stopped(run))) return 'stopped';
    const level = request.by === 'planner' ? (request.level ?? null) : null;
    const payload = personal
      ? { ...request.payload, ...PERSON_RESUME, level }
      : { ...request.payload, by: request.by, level };
    const { replayed } = await this.commands.accept('resume', run.key, payload, {
      idempotencyKey: request.event,
      actor: request.actor,
    });
    return replayed ? 'replayed' : 'accepted';
  }
}
