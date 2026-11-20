import { CONTRACT_KIND, isSubtask } from '../../contract/subtask';
import type { RunEntity } from '../../history/entities';

/** The steps whose first prompt of a chat carries the starter's contract. */
const BRIEFED_STEPS: readonly string[] = ['research', 'plan'];

type ParentDocument = (run: RunEntity, kind: string) => Promise<string | null>;

/**
 * What a run that was started by another run is told beyond its own inputs. Today that is the contract the starter
 * holds right now, in the first prompt of a subtask's research and plan chat. It is built in this one place.
 */
export class StarterBriefing {
  constructor(private readonly parentDocument: ParentDocument) {}

  /** The text a prompt gets, or an empty string: a run that is not a subtask, another step or a continued chat gets none. */
  async textFor(run: RunEntity, step: string, options: { continued: boolean }): Promise<string> {
    if (options.continued || !isSubtask(run) || !BRIEFED_STEPS.includes(step)) {
      return '';
    }
    const contract = await this.parentDocument(run, CONTRACT_KIND);
    return contract?.trim() ? `\n\nContract:\n${contract.trimEnd()}` : '';
  }
}
