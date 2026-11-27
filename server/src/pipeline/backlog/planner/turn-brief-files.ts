import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { sessionHome } from '../../../history/session-group';
import { agentStateDir } from '../../../sandbox/sandbox-launch';
import { allTasks, hasBriefFile } from './turn-lines';
import { plannerChatKey } from './planner-chat-key';
import type { TurnState } from './turn-state';

function writeFile(file: string, text: string): void {
  writeFileSync(file, text);
  chmodSync(file, 0o644);
}

function makeDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
}

/**
 * Writes the files the chat reads from `/work/brief`: the brief of each task that has not started, and every decision,
 * newest first. A task that started or was dropped leaves no file.
 */
export function writeTurnBriefFiles(root: string, backlogId: number, state: TurnState): void {
  const dir = join(agentStateDir(root, plannerChatKey(backlogId), sessionHome('backlog-plan')), 'briefs');
  const tasks = join(dir, 'tasks');
  makeDir(dir);
  rmSync(tasks, { recursive: true, force: true });
  makeDir(tasks);
  for (const task of allTasks(state).filter(hasBriefFile)) {
    writeFile(join(tasks, `${task.slug}.md`), task.description);
  }
  const decisions = state.allDecisions.map((item) => `- ${item.text} (${item.who}, ${item.at})`);
  writeFile(join(dir, 'decisions.md'), `${decisions.length > 0 ? decisions.join('\n') : 'none'}\n`);
}
