import { readPlanChat } from '../contract/plan-chat';
import { LEGACY_MACHINE } from '../contract/people';
import type { StatsRows } from '../history/stats.repository';
import { countedRunsOf } from './stats-units';

/**
 * Messages people wrote in the range, each counted once: the prompts of top-level runs a person started, the answers
 * with a person, the person's plan chat messages, and the person's backlog chat messages. A plan chat message sent
 * as an answer is the answer command already counted, so its entry (`message-<command id>`) is left out.
 */
export function personMessagesOf(rows: StatsRows, rangeStart: string | null): number {
  const prompts = countedRunsOf(rows.runs).filter(
    ({ run }) => !!run.startedBy && run.startedBy !== LEGACY_MACHINE,
  ).length;
  const answered = new Set(rows.person.answers.map(({ id }) => `message-${id}`));
  const chat = rows.person.planChats
    .flatMap((body) => readPlanChat(body).entries)
    .filter(
      (entry) =>
        entry.role === 'person' &&
        entry.kind === undefined &&
        (rangeStart === null || entry.at >= rangeStart) &&
        !answered.has(entry.key),
    ).length;
  return prompts + rows.person.answers.length + chat + rows.person.backlogMessages.length;
}
