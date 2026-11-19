import type { BacklogEventKind } from '../../../contract/backlog';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import { BacklogRepository } from '../../../history/backlog.repository';
import { repositoryDatabase } from '../../../history/repository.spec-helpers';

/** An in-memory database with the backlog and chat repositories and a fake clock, for the planner's specs. */
export async function plannerDatabase() {
  const db = await repositoryDatabase();
  const backlogs = db.app.get(BacklogRepository);
  const chat = db.app.get(BacklogChatRepository);
  return {
    ...db,
    backlogs,
    chat,
    async addBacklog(name = 'alpha', repositories: string[] = ['web']): Promise<number> {
      const saved = await backlogs.saveBacklog({
        name,
        owner: 'owner',
        repositories,
        mergeMode: 'green',
        paused: false,
        createdAt: db.clock.iso(),
      });
      return saved.id as number;
    },
    async addMessage(backlogId: number, text: string, key = `message:${text}`): Promise<boolean> {
      return (await chat.addPersonMessage(backlogId, text, key)) !== null;
    },
    addEvent(
      backlogId: number,
      key: string,
      kind: BacklogEventKind = 'task-merged',
      facts: Record<string, string> = {},
    ): Promise<boolean> {
      return backlogs.recordEvent(backlogId, key, kind, facts);
    },
  };
}
