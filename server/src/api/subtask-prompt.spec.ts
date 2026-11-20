import { DocumentRepository } from '../history/document.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import type { Subtask } from '../contract/subtask';
import { subtaskPromptOf } from './subtask-prompt';

function task(id: string, extra: Partial<Subtask> = {}): Subtask {
  return {
    id,
    title: `Title ${id}`,
    description: `Do ${id}.`,
    depends: [],
    files: [`${id}.ts`],
    proof: `${id}.spec.ts`,
    status: 'waiting',
    ...extra,
  };
}

const REQUIREMENTS = JSON.stringify({ prompt: 'Work, and only this work.' });

async function setup() {
  const db = await repositoryDatabase();
  const runs = db.app.get(RunRepository);
  const documents = db.app.get(DocumentRepository);
  const parent = await runs.openWaiting('p-1', '/target');
  await documents.putDocument(parent, 'requirements', REQUIREMENTS);
  return { db, runs, documents, parent };
}

describe('subtaskPromptOf', () => {
  it('carries no task map: that is told by the briefing of each chat', async () => {
    const { db, runs, documents, parent } = await setup();
    try {
      const tasks = [task('a', { depends: ['b'] }), task('b', { status: 'merged' })];
      await runs.openSubtask('p-1-b', parent.id, 'b');

      const prompt = await subtaskPromptOf(documents, parent, tasks[0]);

      expect(prompt).not.toContain('Task map');
      expect(prompt).not.toContain('Merged dependency');
      expect(prompt.split('\n\n').map((part) => part.split('\n')[0])).toEqual([
        'Title a',
        'Do a.',
        'files: a.ts',
        'proof: a.spec.ts',
        'Requirements of the parent run, for context:',
        expect.stringMatching(/^branch: /),
      ]);
    } finally {
      await db.close();
    }
  });

  it('refuses a parent with no requirements', async () => {
    const { db, runs, documents } = await setup();
    try {
      const bare = await runs.openWaiting('p-2', '/target');
      const only = task('a');

      await expect(subtaskPromptOf(documents, bare, only)).rejects.toThrow('requirements is missing');
    } finally {
      await db.close();
    }
  });

  it('puts a keep line into the prompt of the tasks it names only', async () => {
    const { db, documents, parent } = await setup();
    try {
      const tasks = [task('a'), task('b')];
      const before = await subtaskPromptOf(documents, parent, tasks[1]);
      await documents.putDocument(
        parent,
        'keep',
        JSON.stringify([{ capability: 'login works', proof: 'login.spec.ts', tasks: ['a'] }]),
      );

      const named = await subtaskPromptOf(documents, parent, tasks[0]);
      const other = await subtaskPromptOf(documents, parent, tasks[1]);

      expect(named).toContain('Kept capabilities');
      expect(named).toContain('- login works (proof: login.spec.ts)');
      expect(other).toBe(before);
    } finally {
      await db.close();
    }
  });
});
