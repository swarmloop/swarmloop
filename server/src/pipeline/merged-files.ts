import type { DocumentRepository } from '../history/document.repository';
import { ARTIFACTS } from '../steps/contract/artifacts';

/** The files a merged task's run recorded as changed by its merge, or none when it recorded none. */
export async function mergedFilesOf(documents: DocumentRepository, runKey: string): Promise<string[]> {
  const body = await documents.latestBody(runKey, ARTIFACTS.mergedFiles.kind);
  return (body ?? '').split('\n').filter(Boolean);
}
