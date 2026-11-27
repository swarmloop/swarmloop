import type { DocumentEntity, RunEntity } from './entities';

/** What the open items of a run say about its state: the rule `RunOpenItems` stores the state by. */
export abstract class OpenItemRules {
  /** The kinds of document whose latest write can change the open items of a run. */
  abstract readonly kinds: readonly string[];

  abstract facts(input: { run: RunEntity; documents: DocumentEntity[]; pasteUrls: string[]; ofBacklog: boolean }): {
    needsAnswers: boolean;
    asksPlanner: boolean;
  };
}
