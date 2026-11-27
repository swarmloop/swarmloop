import { Injectable } from '@nestjs/common';
import { Clock } from '../core/clock';
import type { StateReason } from '../contract/run-state';
import { CommandRepository } from '../history/command.repository';
import type { RunEntity } from '../history/entities';
import { EventRepository } from '../history/event.repository';
import { STALL_COUNTER } from '../history/loop-detail';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { VisitRepository } from '../history/visit.repository';
import { ContainerGate } from '../sandbox/container-gate';
import { stallDecision, type StallDecision } from './stall-decision';

type Try = Extract<StallDecision, { kind: 'try' }>;

/** Finds the runs that stopped moving with no reason, and writes what became of them. It sends no command itself. */
@Injectable()
export class StallWatch {
  constructor(
    private readonly runs: RunRepository,
    private readonly visits: VisitRepository,
    private readonly commands: CommandRepository,
    private readonly events: EventRepository,
    private readonly gate: ContainerGate,
    private readonly clock: Clock,
  ) {}

  /** The runs to act on now. Nothing while the server is paused, so a rebuild never cuts a run just resumed. */
  async decisions(claimed: (key: string) => boolean): Promise<{ run: RunEntity; decision: StallDecision }[]> {
    if (this.gate.paused()) return [];
    const due: { run: RunEntity; decision: StallDecision }[] = [];
    for (const run of await this.runs.listRuns({ state: 'idle' })) {
      if (run.stateReason !== null || claimed(run.key)) continue;
      const commands = await this.commands.listForRun(run.id);
      if (commands.some((command) => ['accepted', 'executing'].includes(command.state))) continue;
      const decision = stallDecision({
        now: this.clock.now(),
        key: run.key,
        currentStep: run.currentStep,
        visits: await this.visits.listStats(run.id),
        commands,
      });
      if (decision) due.push({ run, decision });
    }
    return due;
  }

  /** The run goes to its owner with `reason`, unless it moved since it was read. */
  async askPerson(seen: RunEntity, reason: StateReason): Promise<void> {
    const run = await this.runs.findRun(seen.key);
    if (run?.state !== 'idle' || run.stateReason !== null) return;
    if ((await this.commands.pending(run.id)).length > 0) return;
    await this.runs.change(seen.key, (row) => {
      if (row.state !== 'idle' || row.stateReason !== null) return;
      writeRunState(row, { status: 'waiting', ownerPid: null, reason });
    });
  }

  /** One line in the run's events for the try the server just sent. */
  noteTry(run: RunEntity, decision: Try): Promise<void> {
    return this.events.recordLoop(run, STALL_COUNTER, decision.tryNumber, decision.line);
  }
}
