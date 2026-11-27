import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { SwarmloopError } from '../core/swarmloop-error';
import { conditionalUpdate } from './conditional-write';
import { DocumentEntity, PasteEntity, RunEntity } from './entities';
import { BacklogTaskEntity } from './backlog.entities';
import { latestDocumentsOf } from './latest-document';
import { OpenItemRules } from './open-item-rules';
import { changedColumns, readValue } from './run-read';
import { keepsWrittenState, writeOpenItemState } from './run-state';

/** Stores the state of a run in the transaction of the write that changes its open items. */
@Injectable()
export class RunOpenItems {
  constructor(private readonly rules: OpenItemRules) {}

  /**
   * Writes the state the open items of the run give, inside the caller's transaction. Revision and update time stay: the
   * state is no change of the run. Reads again when the write loses. Returns whether a row was written, and false for a
   * run that is gone.
   */
  async hold(manager: EntityManager, ref: { id: number } | { key: string }): Promise<boolean> {
    const runs = manager.getRepository(RunEntity);
    let lost: string[] = [];
    for (let tries = 0; tries < 3; tries++) {
      const run = await runs.findOne({ where: ref });
      if (!run || keepsWrittenState(run)) return false;
      writeOpenItemState(run, await this.factsOf(manager, run));
      const changed = changedColumns(run);
      lost = Object.keys(changed);
      if (lost.length === 0) return false;
      if (await conditionalUpdate(runs, run.id, changed, (column) => readValue(run, column))) return true;
    }
    throw new SwarmloopError(
      `run ${'id' in ref ? ref.id : ref.key}: ${lost.join(', ')} changed under every one of three tries; the state was not written`,
    );
  }

  private async factsOf(manager: EntityManager, run: RunEntity) {
    const documents = await latestDocumentsOf(manager.getRepository(DocumentEntity), [run.id], this.rules.kinds);
    const asksPaste = run.currentStep === 'requirements' && documents.some(({ kind }) => kind === 'pending');
    const pastes = asksPaste ? await manager.getRepository(PasteEntity).find({ where: { runKey: run.key } }) : [];
    const input = { run, documents, pasteUrls: pastes.map((paste) => paste.url), ofBacklog: false };
    const facts = this.rules.facts(input);
    // The backlog link only decides who holds a question: it is read only when an item is open.
    return facts.needsAnswers ? this.rules.facts({ ...input, ofBacklog: await this.ofBacklog(manager, run) }) : facts;
  }

  /** True when the run, or a run above it, is the run of a task of a backlog. */
  private async ofBacklog(manager: EntityManager, run: RunEntity): Promise<boolean> {
    const seen = new Set<number>();
    for (
      let at: RunEntity | null = run;
      at && !seen.has(at.id);
      at = typeof at.parentRunId === 'number' ? await manager.findOneBy(RunEntity, { id: at.parentRunId }) : null
    ) {
      seen.add(at.id);
      if (await manager.findOne(BacklogTaskEntity, { where: { runKey: at.key } })) return true;
    }
    return false;
  }
}
