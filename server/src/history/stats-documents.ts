import type { Repository } from 'typeorm';
import { PLAN_CHAT_KIND } from '../contract/plan-chat';
import type { DocumentEntity } from './entities';
import { placeholders } from './sql-placeholders';

/** The latest document of each of `kinds` for each of the runs with these ids. */
export interface WantedDocuments {
  runIds: number[];
  kinds: string[];
}

export interface StatsDocument {
  runId: number;
  kind: string;
  body: string;
}

/**
 * Every document the statistics read, oldest first, in one statement: the latest of each wanted kind of each wanted
 * run, and the latest plan chat of each run that changed since `since` (of every run when null), when written since.
 * The plan chat is found through the (run_id, kind, id) index, so no document of an unchanged run is touched.
 */
export async function statsDocuments(
  documents: Repository<DocumentEntity>,
  since: string | null,
  wanted: WantedDocuments[],
): Promise<StatsDocument[]> {
  const params: unknown[] = [];
  const asked = wanted.filter(({ runIds, kinds }) => runIds.length > 0 && kinds.length > 0);
  const latestOfWanted = asked.map(({ runIds, kinds }) => {
    params.push(...runIds, ...kinds);
    return `(run_id IN (${placeholders(runIds)}) AND kind IN (${placeholders(kinds)}))`;
  });
  const changed =
    since === null
      ? ''
      : ' WHERE run.updated_at >= ? OR run.id IN (SELECT command.run_id FROM commands command WHERE command.created_at >= ?)';
  params.push(PLAN_CHAT_KIND);
  if (since !== null) {
    params.push(since, since, since);
  }
  const latestChats = `SELECT (SELECT MAX(latest.id) FROM documents latest WHERE latest.run_id = run.id AND latest.kind = ?) FROM runs run${changed}`;
  const chats = `document.id IN (${latestChats})${since === null ? '' : ' AND document.created_at >= ?'}`;
  const wantedIds =
    asked.length === 0
      ? ''
      : `document.id IN (SELECT MAX(id) FROM documents WHERE ${latestOfWanted.join(' OR ')} GROUP BY run_id, kind) OR `;
  // The wanted ids come first in the text, so their values come first in the parameters.
  return documents.manager.query(
    `SELECT document.run_id AS runId, document.kind AS kind, document.body AS body
     FROM documents document WHERE ${wantedIds}(${chats}) ORDER BY document.id`,
    params,
  );
}

/** The documents among `read` of the wanted kinds and runs, in the order they were read. */
export function documentsFor(read: StatsDocument[], { runIds, kinds }: WantedDocuments): StatsDocument[] {
  const runSet = new Set(runIds);
  const kindSet = new Set(kinds);
  return read.filter(({ runId, kind }) => runSet.has(runId) && kindSet.has(kind));
}
