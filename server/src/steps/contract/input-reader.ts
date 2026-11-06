import type { DocumentRepository } from '../../history/document.repository';
import { SwarmloopError } from '../../core/swarmloop-error';
import type { Artifact } from './artifact';
import type { InputNeed, InputSpec, StepInput } from './step-contract';

/** Loads the documents a step declares, parsed by the codec of their artifact. */
export class InputReader {
  constructor(private readonly documents: DocumentRepository) {}

  /** Every input that is not `late`, one after the other. An absent `run` input fails the visit. */
  async read<S extends InputSpec>(key: string, spec: S): Promise<StepInput<S>> {
    const input: Record<string, unknown> = {};
    for (const [name, entry] of Object.entries(spec)) {
      if (entry.late) {
        continue;
      }
      const value = await this.reread(key, entry.artifact);
      if (value === null && entry.need === 'run') {
        throw new SwarmloopError(`${entry.artifact.kind} is missing`);
      }
      input[name] = value;
    }
    return input as StepInput<S>;
  }

  /** The latest stored value, or null when nothing is stored. */
  async reread<T>(key: string, artifact: Artifact<T>): Promise<T | null> {
    const body = await this.documents.latestBody(key, artifact.kind);
    return body === null ? null : artifact.parse(body);
  }

  /** True when a document of `artifact` is stored and no document of `since` is newer than it. */
  async newer(key: string, artifact: Artifact<unknown>, since: Artifact<unknown>): Promise<boolean> {
    const latest = await this.documents.latestDocument(key, artifact.kind);
    if (!latest) {
      return false;
    }
    const earlier = await this.documents.latestDocument(key, since.kind);
    return !earlier || earlier.id < latest.id;
  }

  /** The first kind of this need that has no document, or null. A stored empty document counts as present. */
  async missing(key: string, spec: InputSpec, need: InputNeed): Promise<string | null> {
    for (const entry of Object.values(spec)) {
      if (entry.need === need && !(await this.documents.hasDocument(key, entry.artifact.kind))) {
        return entry.artifact.kind;
      }
    }
    return null;
  }
}
