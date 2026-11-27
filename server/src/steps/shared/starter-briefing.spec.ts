import { DocumentRepository } from '../../history/document.repository';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import type { Subtask } from '../../contract/subtask';
import { StarterBriefing } from './starter-briefing';

function task(id: string, extra: Partial<Subtask> = {}): Subtask {
  return {
    id,
    title: `Title ${id}`,
    description: '',
    depends: [],
    files: [`${id}.ts`],
    proof: `${id}.spec.ts`,
    status: 'waiting',
    ...extra,
  };
}

const TASKS = [
  task('a', { depends: ['b'], covers: ['R1'] }),
  task('b', { status: 'merged', covers: ['R2'] }),
  task('c', { covers: ['R3'] }),
];
const CONTRACT = '- tool (owner b): the tool takes a path\n- cache (owner c): keyed by host\n\ndecisions:\n';
const DECISION = '- subtask c at 2026-11-20T09:00:00.000Z: hosts are lower case\n';

async function setup() {
  const db = await repositoryDatabase();
  const runs = db.app.get(RunRepository);
  const documents = db.app.get(DocumentRepository);
  const parent = await runs.openWaiting('p-1', '/target');
  await documents.putDocument(parent, 'subtasks', JSON.stringify(TASKS));
  await documents.putDocument(parent, 'contract', CONTRACT);
  await documents.putDocument(
    parent,
    'requirement_list',
    JSON.stringify([
      { id: 'R1', text: 'first' },
      { id: 'R2', text: 'second' },
      { id: 'R3', text: 'third' },
    ]),
  );
  const sibling = await runs.openSubtask('p-1-b', parent.id, 'b');
  await documents.putDocument(
    sibling,
    'merge_request',
    'project: web\niid: 7\nurl: https://host/7\ndraft: false\n\nMakes the tool.\n',
  );
  await documents.putDocument(sibling, 'merged_files', 'b.ts\nshared/tool.ts');
  const run = await runs.openSubtask('p-1-a', parent.id, 'a');
  const briefing = new StarterBriefing(runs, documents);
  const decide = (line: string) => documents.putDocument(parent, 'contract', `${CONTRACT}${line}`);
  return { db, runs, documents, parent, run, briefing, decide };
}

describe('the starter briefing', () => {
  it('tells the first prompt of a chat the map, the dependencies, the decisions and the requirement ids', async () => {
    const { db, run, briefing, decide } = await setup();
    try {
      await decide(DECISION);

      const prepared = await briefing.prepare(run, 'implement', null, { continued: false });

      expect(prepared?.told).toBe(prepared?.full);
      const text = prepared?.told ?? '';
      expect(text).toContain('- b (merged): Title b - files: b.ts - owns: tool (delivered)');
      expect(text).toContain('- c (waiting): Title c - files: c.ts - owns: cache (pending)');
      expect(text).toContain('Merged dependency b, files: b.ts, shared/tool.ts\nMakes the tool.');
      expect(text).toContain('- subtask c at 2026-11-20T09:00:00.000Z: hosts are lower case');
      expect(text).toContain('Requirements of this task:\n- R1: first');
      expect(text).toContain('Requirements that belong to other tasks:\n- b: R2\n- c: R3');
    } finally {
      await db.close();
    }
  });

  it('tells a continued chat only a new decision, and a second continued prompt nothing', async () => {
    const { db, run, briefing, decide } = await setup();
    try {
      await briefing.remember(run, 'chat-1', (await briefing.prepare(run, 'implement', null, { continued: false }))!);
      await decide(DECISION);

      const first = await briefing.prepare(run, 'implement', 'chat-1', { continued: true });
      await briefing.remember(run, 'chat-1', first!);
      const second = await briefing.prepare(run, 'implement', 'chat-1', { continued: true });

      expect(first?.told).toBe(
        '\n\nNew decisions since your last prompt:\n- subtask c at 2026-11-20T09:00:00.000Z: hosts are lower case',
      );
      expect(second?.told).toBe('');
      expect(second?.full).toContain('Task map');
    } finally {
      await db.close();
    }
  });

  it('tells a continued chat a dependency that merged since', async () => {
    const { db, run, runs, parent, documents, briefing } = await setup();
    try {
      const tasks = [task('a', { depends: ['b', 'c'] }), TASKS[1], TASKS[2]];
      await documents.putDocument(parent, 'subtasks', JSON.stringify(tasks));
      await briefing.remember(run, 'chat-1', (await briefing.prepare(run, 'plan', null, { continued: false }))!);
      const merged = await runs.openSubtask('p-1-c', parent.id, 'c');
      await documents.putDocument(merged, 'merged_files', 'c.ts');
      await documents.putDocument(
        parent,
        'subtasks',
        JSON.stringify([task('a', { depends: ['b', 'c'] }), TASKS[1], { ...TASKS[2], status: 'merged' }]),
      );

      const text = (await briefing.prepare(run, 'plan', 'chat-1', { continued: true }))?.told ?? '';

      expect(text).toContain('Merged dependency c, files: c.ts');
      expect(text).toContain('- cache: keyed by host');
      expect(text).not.toContain('Merged dependency b');
    } finally {
      await db.close();
    }
  });

  it('tells research and plan, which share one chat, the state once', async () => {
    const { db, run, briefing } = await setup();
    try {
      const research = await briefing.prepare(run, 'research', null, { continued: false });
      await briefing.remember(run, 'shared-chat', research!);

      const plan = await briefing.prepare(run, 'plan', 'shared-chat', { continued: true });

      expect(research?.told).toContain('Task map');
      expect(plan?.told).toBe('');
    } finally {
      await db.close();
    }
  });

  it('tells a fresh chat the whole state again', async () => {
    const { db, run, briefing } = await setup();
    try {
      await briefing.remember(run, 'old-chat', (await briefing.prepare(run, 'implement', null, { continued: false }))!);

      const fresh = await briefing.prepare(run, 'implement', null, { continued: true });
      const unknown = await briefing.prepare(run, 'implement', 'new-chat', { continued: true });

      expect(fresh?.told).toContain('Task map');
      expect(unknown?.told).toContain('Task map');
    } finally {
      await db.close();
    }
  });

  it('tells a run that is not a subtask, and a step that is not briefed, nothing', async () => {
    const { db, run, parent, briefing } = await setup();
    try {
      expect(await briefing.prepare(parent, 'implement', null, { continued: false })).toBeNull();
      expect(await briefing.fullText(parent)).toBe('');
      expect(await briefing.prepare(run, 'branch', null, { continued: false })).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('gives the files its task lists, and none for a run that is not a subtask', async () => {
    const { db, run, parent, briefing } = await setup();
    try {
      expect(await briefing.ownFiles(run)).toEqual(['a.ts']);
      expect(await briefing.ownFiles(parent)).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
