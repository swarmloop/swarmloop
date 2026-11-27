import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { sessionHome } from '../../../history/session-group';
import { agentStateDir } from '../../../sandbox/sandbox-launch';
import { plannerChatKey } from './planner-chat-key';
import { writeTurnBriefFiles } from './turn-brief-files';
import type { TaskState, TurnState } from './turn-state';

function task(slug: string, overrides: Partial<TaskState> = {}): TaskState {
  return {
    slug,
    title: slug,
    description: `Brief of ${slug}`,
    status: 'waiting',
    wait: '',
    runKey: null,
    repositories: [],
    covers: [],
    depends: [],
    files: [],
    fixesMain: null,
    subtasks: [],
    ...overrides,
  };
}

function stateOf(items: TaskState[]): TurnState {
  const all = [
    { id: 2, text: 'second', who: 'owner', at: 't2' },
    { id: 1, text: 'first', who: 'planner', at: 't1' },
  ];
  return {
    backlog: { id: 3, name: 'alpha', repositories: [], mergeMode: 'green', paused: false },
    active: null,
    planned: [],
    items,
    decisions: [...all].reverse(),
    olderDecisions: 0,
    allDecisions: all,
    messages: [],
    olderMessages: 0,
    messagesOfTurn: [],
    lastSeen: null,
    events: [],
  };
}

describe('writeTurnBriefFiles', () => {
  it('writes the brief of each task that has not started and every decision newest first', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-turn-brief-'));
    const dir = join(agentStateDir(root, plannerChatKey(3), sessionHome('backlog-plan')), 'briefs');

    writeTurnBriefFiles(
      root,
      3,
      stateOf([task('idea'), task('started', { runKey: 'r-1' }), task('done', { status: 'merged' })]),
    );

    expect(readFileSync(join(dir, 'tasks', 'idea.md'), 'utf8')).toBe('Brief of idea');
    expect(existsSync(join(dir, 'tasks', 'started.md'))).toBe(false);
    expect(existsSync(join(dir, 'tasks', 'done.md'))).toBe(false);
    expect(readFileSync(join(dir, 'decisions.md'), 'utf8')).toBe('- second (owner, t2)\n- first (planner, t1)\n');
    expect(statSync(join(dir, 'tasks')).mode & 0o777).toBe(0o755);
    expect(statSync(join(dir, 'decisions.md')).mode & 0o777).toBe(0o644);
  });

  it('removes the file of a task that started or was dropped', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-turn-brief-'));
    const dir = join(agentStateDir(root, plannerChatKey(3), sessionHome('backlog-plan')), 'briefs');
    writeTurnBriefFiles(root, 3, stateOf([task('a'), task('b')]));
    writeFileSync(join(dir, 'tasks', 'stray.md'), 'old');

    writeTurnBriefFiles(root, 3, stateOf([task('a', { runKey: 'a-1' })]));

    expect(existsSync(join(dir, 'tasks', 'a.md'))).toBe(false);
    expect(existsSync(join(dir, 'tasks', 'b.md'))).toBe(false);
    expect(existsSync(join(dir, 'tasks', 'stray.md'))).toBe(false);
  });
});
