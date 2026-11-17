import { Injectable } from '@nestjs/common';
import { Clock } from '../core/clock';
import type { StateReason } from '../contract/run-state';
import { CheckoutRepository } from '../history/checkout.repository';
import { CommandRepository } from '../history/command.repository';
import { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { EventRepository } from '../history/event.repository';
import { STALL_COUNTER } from '../history/loop-detail';
import { RunRepository } from '../history/run.repository';
import { deriveState, isReturned, writeRunState } from '../history/run-state';
import { VisitRepository } from '../history/visit.repository';
import { ContainerGate } from '../sandbox/container-gate';
import { OPEN_ITEM_KINDS, openItems } from '../steps/shared/open-items';
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
    private readonly documents: DocumentRepository,
    private readonly checkouts: CheckoutRepository,
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
    return this.withoutDerivedReason(due);
  }

  /**
   * Drops the runs that show a reason in the run view: open questions, a paste that is asked for, or a return to
   * implement. Only the latest documents the open items read are loaded, for all due runs at once.
   */
  private async withoutDerivedReason<T extends { run: RunEntity }>(due: T[]): Promise<T[]> {
    const found = await this.documents.latestDocuments(
      due.map(({ run }) => run.id),
      OPEN_ITEM_KINDS,
    );
    const kept: T[] = [];
    for (const item of due) {
      const documents = found.filter((document) => document.runId === item.run.id);
      const asksPaste = item.run.currentStep === 'requirements' && documents.some(({ kind }) => kind === 'pending');
      const pastes = asksPaste ? await this.checkouts.listPastes(item.run.key) : [];
      const open = openItems(
        item.run,
        documents,
        pastes.map((paste) => paste.url),
      );
      const { reason } = deriveState(item.run, { needsAnswers: open.length > 0, returned: isReturned(item.run) });
      if (reason === null) kept.push(item);
    }
    return kept;
  }

  /** The run goes to its owner with `reason`, unless it moved since it was read. */
  async askPerson(seen: RunEntity, reason: StateReason): Promise<void> {
    const run = await this.runs.findRun(seen.key);
    if (run?.state !== 'idle' || run.stateReason !== null) return;
    if ((await this.commands.pending(run.id)).length > 0) return;
    writeRunState(run, { status: 'waiting', ownerPid: null, reason });
    await this.runs.saveRun(run);
  }

  /** One line in the run's events for the try the server just sent. */
  noteTry(run: RunEntity, decision: Try): Promise<void> {
    return this.events.recordLoop(run, STALL_COUNTER, decision.tryNumber, decision.line);
  }
}
