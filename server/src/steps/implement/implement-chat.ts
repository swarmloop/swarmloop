import { implementation } from '../../agent-result/definitions/implementation';
import { implementationImprove } from '../../agent-result/definitions/implementation-improve';
import type { DocumentRepository } from '../../history/document.repository';
import { ARTIFACTS } from '../contract/artifacts';

/**
 * The result definition the shared implement chat received last. Both implement steps write their own result after
 * `implementation_result`, so the newer of the two result kinds names the step that ran last.
 */
export async function lastReceived(documents: DocumentRepository, key: string): Promise<string> {
  const first = await documents.latestDocument(key, ARTIFACTS.implementationResult.kind);
  const improved = await documents.latestDocument(key, ARTIFACTS.implementationImproveResult.kind);
  return improved && (!first || improved.id > first.id) ? implementationImprove.name : implementation.name;
}
