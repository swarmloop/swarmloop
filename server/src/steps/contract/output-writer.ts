import type { DocumentDraft } from '../../history/visit';
import { textDocument } from '../shared/handoff';
import type { Artifact } from './artifact';
import type { ArtifactValue } from './step-contract';

/** The documents of a result's outputs, in order. A step may write only the artifacts it lists in `outputs`. */
export function outputDrafts(
  step: string,
  declared: readonly Artifact<unknown>[],
  outputs: readonly ArtifactValue[],
): DocumentDraft[] {
  return outputs.map(({ artifact, value }) => {
    if (!declared.some((item) => item.kind === artifact.kind)) {
      throw new Error(`${step} may not write ${artifact.kind}`);
    }
    return textDocument(artifact.kind, artifact.format(value));
  });
}
