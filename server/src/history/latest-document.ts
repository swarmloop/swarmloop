import { In } from 'typeorm';
import type { Repository } from 'typeorm';
import type { DocumentEntity } from './entities';

/** The body of the latest document of a kind among the documents of a run, in the order they were written. */
export function latest(documents: Pick<DocumentEntity, 'kind' | 'body'>[], kind: string): string | null {
  const found = [...documents].reverse().find((document) => document.kind === kind);
  return found?.body ?? null;
}

/** The newest document of each of `kinds` for each of the runs, oldest first, in two reads whatever the number of runs. */
export async function latestDocumentsOf(
  documents: Repository<DocumentEntity>,
  runIds: number[],
  kinds: readonly string[],
): Promise<DocumentEntity[]> {
  if (runIds.length === 0 || kinds.length === 0) {
    return [];
  }
  const newest: { id: number }[] = await documents
    .createQueryBuilder('document')
    .select('MAX(document.id)', 'id')
    .where('document.runId IN (:...runIds) AND document.kind IN (:...kinds)', { runIds, kinds })
    .groupBy('document.runId')
    .addGroupBy('document.kind')
    .getRawMany();
  return newest.length === 0
    ? []
    : documents.find({ where: { id: In(newest.map(({ id }) => Number(id))) }, order: { id: 'ASC' } });
}
