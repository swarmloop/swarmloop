import { beforeEach, describe, expect, it, vi } from 'vitest';
import { backlogChatView, backlogView } from '../test/backlog-fixtures';
import { api } from './api';
import { backlogPath } from './backlog-path';
import {
  addBacklogRepository,
  addBacklogTasks,
  changeBacklogTask,
  createBacklog,
  deleteBacklogTask,
  getBacklog,
  getBacklogChat,
  getRepositoryMain,
  listBacklogs,
  mergeBacklogTask,
  pauseBacklog,
  resumeBacklogTurn,
  runBacklog,
  runBacklogTaskNow,
  runMilestone,
  sendBacklogMessage,
  skipBacklogTask,
  unpauseBacklog,
} from './backlog-endpoints';

vi.mock('./api', () => ({ api: vi.fn() }));

beforeEach(() => {
  vi.mocked(api).mockReset();
});

const calls = () => vi.mocked(api).mock.calls;

describe('backlog endpoints', () => {
  it('reads with GET and encodes the names', async () => {
    await listBacklogs();
    await getBacklog('a b/c');
    await getBacklogChat('a b/c');
    await getRepositoryMain('own/repo');
    expect(calls()).toEqual([
      ['/backlogs'],
      ['/backlogs/a%20b%2Fc'],
      ['/backlogs/a%20b%2Fc/messages'],
      ['/repositories/own%2Frepo/main'],
    ]);
  });

  it('returns the answer of the route', async () => {
    vi.mocked(api).mockResolvedValueOnce(backlogView()).mockResolvedValueOnce(backlogChatView());
    const view = await getBacklog('swarmloop');
    expect(view.requirements.filter((item) => item.status === 'closed')).toHaveLength(4);
    expect(view.requirements).toHaveLength(7);
    expect((await getBacklogChat('swarmloop')).messages).toHaveLength(1);
  });

  it('posts the actions with their bodies', async () => {
    const body = { name: 'shop', repositories: ['a'], mergeMode: 'ok' as const };
    await createBacklog(body);
    await resumeBacklogTurn('a b');
    await runMilestone('a b', 3);
    await runBacklog('a b');
    await pauseBacklog('a b');
    await addBacklogRepository('a b', { repository: 'o/r' });
    await addBacklogTasks('a b', [{ id: 'one', title: 'One', description: 'd' }]);
    await skipBacklogTask('a b', 'x/y');
    await mergeBacklogTask('a b', 'x/y');
    await runBacklogTaskNow('a b', 'x/y');
    expect(calls()).toEqual([
      ['/backlogs', { method: 'POST', body: JSON.stringify(body) }],
      ['/backlogs/a%20b/turns/resume', { method: 'POST' }],
      ['/backlogs/a%20b/milestones/3/run', { method: 'POST' }],
      ['/backlogs/a%20b/run', { method: 'POST' }],
      ['/backlogs/a%20b/pause', { method: 'POST' }],
      ['/backlogs/a%20b/repositories', { method: 'POST', body: JSON.stringify({ repository: 'o/r' }) }],
      [
        '/backlogs/a%20b/tasks',
        { method: 'POST', body: JSON.stringify([{ id: 'one', title: 'One', description: 'd' }]) },
      ],
      ['/backlogs/a%20b/tasks/x%2Fy/skip', { method: 'POST' }],
      ['/backlogs/a%20b/tasks/x%2Fy/merge', { method: 'POST' }],
      ['/backlogs/a%20b/tasks/x%2Fy/run', { method: 'POST' }],
    ]);
  });

  it('changes, deletes and unpauses with their methods', async () => {
    await changeBacklogTask('a b', 'x/y', { title: 'New' });
    await deleteBacklogTask('a b', 'x/y');
    await unpauseBacklog('a b');
    expect(calls()).toEqual([
      ['/backlogs/a%20b/tasks/x%2Fy', { method: 'PATCH', body: JSON.stringify({ title: 'New' }) }],
      ['/backlogs/a%20b/tasks/x%2Fy', { method: 'DELETE' }],
      ['/backlogs/a%20b/pause', { method: 'DELETE' }],
    ]);
  });

  it('sends a message with its attachment ids and the idempotency key', async () => {
    await sendBacklogMessage('a b', 'hi', ['u1'], 'k1');
    await sendBacklogMessage('a b', 'plain', [], 'k2');
    expect(calls()).toEqual([
      [
        '/backlogs/a%20b/messages',
        {
          method: 'POST',
          body: JSON.stringify({ text: 'hi', attachments: ['u1'] }),
          headers: { 'Idempotency-Key': 'k1' },
        },
      ],
      [
        '/backlogs/a%20b/messages',
        { method: 'POST', body: JSON.stringify({ text: 'plain' }), headers: { 'Idempotency-Key': 'k2' } },
      ],
    ]);
  });

  it('builds the page path with the name encoded', () => {
    expect(backlogPath('a b/c')).toBe('/backlogs/a%20b%2Fc');
  });
});
