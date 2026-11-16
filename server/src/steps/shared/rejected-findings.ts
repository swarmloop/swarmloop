import type { RejectedFinding } from '../../agent-result/definitions/implementation';
import { ARTIFACTS } from '../contract/artifacts';

/** The findings an implement pass left unfixed, from its stored result. Undefined for any other document or a result with none listed. */
export function rejectedFindings(document: { kind: string; body: string }): RejectedFinding[] | undefined {
  if (document.kind === ARTIFACTS.implementationResult.kind) {
    return ARTIFACTS.implementationResult.parse(document.body).rejected;
  }
  if (document.kind === ARTIFACTS.implementationImproveResult.kind) {
    return ARTIFACTS.implementationImproveResult.parse(document.body).rejected;
  }
  return undefined;
}
