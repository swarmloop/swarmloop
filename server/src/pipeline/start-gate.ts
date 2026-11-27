import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { StepName } from '../contract/steps';
import type { StartBy, StepOptions } from '../core/pipeline-result';
import type { RunEntity } from '../history/entities';
import { AgentDoor } from '../steps/shared/agent-door';
import type { Admission } from '../steps/shared/agent-door';
import { StepRegistry } from '../steps/step.registry';
import { CommandService } from './command.service';
import { PERSON_RESUME } from './resume-sender';
import { RunGuards } from './run-guards';

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
    private readonly guards: RunGuards,
    /** The registry is found when a start is admitted: the steps reach the subtask port, which holds this gate. */
    private readonly modules: ModuleRef,
    private readonly door: AgentDoor,
  ) {}

  /** Whether the run's spend is under MAX_RUN_USD, so a run blocked at the limit may go on by itself. */
  underSpendLimit(run: Pick<RunEntity, 'id'>): Promise<boolean> {
    return this.guards.underSpendLimit(run);
  }

  /** The one check before every hop's agent start: the door decides, with whether the step launches an agent. */
  async admit(key: string, step: StepName, options: StepOptions): Promise<Admission> {
    return this.door.admitStep(key, step, options, await this.launchesAgent(key, step));
  }

  /** Whether a start of the step launches an agent: a server pass, such as a split parent's implement, does not. */
  private async launchesAgent(key: string, step: StepName): Promise<boolean> {
    const found = this.modules.get(StepRegistry, { strict: false }).get(step);
    if (!found) return false;
    return found.launchesAgent ? found.launchesAgent(key) : found.usesModel;
  }

  /** Whether a person stopped the run. The run is read again, so a copy from before the Stop does not count. */
  async stopped(run: Pick<RunEntity, 'key'>): Promise<boolean> {
    return this.door.stopped(run);
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
