import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { DocumentRepository } from '../../history/document.repository';
import { PLAN_CHAT_KIND, type PlanChatEntry } from '../../contract/plan-chat';
import { copyMainWithOrigin, git } from '../../testing/git-fixture';
import { ARTIFACTS } from '../contract/artifacts';
import { withPlan } from '../plan/plan-record';
import { normalizedText, readVisitInput, visitInput, type VisitInputParts } from './visit-input';

const PARTS: VisitInputParts = {
  heads: [
    { repo: 'web', commit: 'bbb' },
    { repo: 'api', commit: 'aaa' },
  ],
  checklist: ['Write the gate', 'Add the spec'],
  handoff: '## research\nFound it at 2026-11-21T20:12:00Z on visit 3.\n',
  answers: ['Use the old way.'],
  returns: ['## code-review\nFix the name.'],
  findings: ['checks\nLint\nunused import'],
  instruction: 'replay it',
};

describe('visitInput', () => {
  it('gives the same digest for the same content with new times, ids, attempts and visits', () => {
    const stamped: VisitInputParts = {
      ...PARTS,
      handoff: '## research\nFound it at 2026-11-22T01:00:07.123Z on visit 9.\n',
      returns: ['## code-review\nFix   the name.'],
      findings: ['checks\nLint\nunused import'],
      instruction: 'replay it',
      answers: ['Use the old way.'],
    };
    expect(visitInput(stamped)).toBe(visitInput(PARTS));
    expect(normalizedText('attempt 4 of 123e4567-e89b-12d3-a456-426614174000 at 1763800000000, try #2')).toBe(
      'attempt of at , try',
    );
    expect(normalizedText('run attempt-ab12cd ended')).toBe('run ended');
  });

  it('does not depend on the order of the heads', () => {
    expect(visitInput({ ...PARTS, heads: [...PARTS.heads].reverse() })).toBe(visitInput(PARTS));
  });

  it.each<[string, Partial<VisitInputParts>]>([
    ['head', { heads: [{ repo: 'web', commit: 'ccc' }, PARTS.heads[1]] }],
    ['checklist item', { checklist: ['Write the gate', 'Add the other spec'] }],
    ['handoff', { handoff: '## research\nFound something else.\n' }],
    ['answer', { answers: ['Use the new way.'] }],
    ['return', { returns: ['## code-review\nFix the other name.'] }],
    ['finding', { findings: ['checks\nLint\nunused export'] }],
    ['instruction', { instruction: 'replay it differently' }],
  ])('gives a new digest for a changed %s', (_name, change) => {
    expect(visitInput({ ...PARTS, ...change })).not.toBe(visitInput(PARTS));
  });

  it('does not read a moved text as the same input', () => {
    expect(visitInput({ ...PARTS, answers: ['a', 'b'], returns: [] })).not.toBe(
      visitInput({ ...PARTS, answers: ['a'], returns: ['b'] }),
    );
  });
});

describe('readVisitInput', () => {
  let root: string;
  let stored: Map<string, string>;
  let documents: DocumentRepository;
  const run = { key: 'run-1', targetPath: null, prompt: 'Build it.' };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'visit-input-'));
    stored = new Map();
    documents = {
      latestBody: async (_key: string, kind: string) => stored.get(kind) ?? null,
      latestDocument: async (_key: string, kind: string) =>
        stored.has(kind) ? { id: 1, body: stored.get(kind) } : null,
    } as unknown as DocumentRepository;
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const chat = (...entries: Partial<PlanChatEntry>[]) =>
    stored.set(PLAN_CHAT_KIND, JSON.stringify({ entries, revisions: [] }));

  it('reads the parts from stored documents, the plan chat and the worktree heads', async () => {
    const worktrees = join(root, 'wt');
    const { clone } = copyMainWithOrigin(worktrees, 'main');
    const head = git(clone, ['rev-parse', 'HEAD']);
    stored.set(
      'requirements',
      withPlan('{"prompt":"p"}\n', { name: 'F', overview: 'o', items: ['Do it'], decision: null }),
    );
    stored.set(ARTIFACTS.handoff.kind, JSON.stringify([{ step: 'research', body: 'Found it.' }]));
    stored.set(ARTIFACTS.answers.kind, 'Use the old way.');
    stored.set(ARTIFACTS.return.kind, '## code-review\nFix the name.');
    stored.set(
      ARTIFACTS.issues.kind,
      JSON.stringify([{ id: 'checks-1', source: 'checks', title: 'Lint', body: 'unused import' }]),
    );
    chat({ key: 'message-1', role: 'person', text: 'Mind the cache.', at: 't', state: 'taken' });
    const deps = { documents, worktrees };

    const read = await readVisitInput(deps, run, 'implement', 'replay it');

    expect(read).toBe(
      visitInput({
        heads: [{ repo: 'main', commit: head }],
        checklist: ['Do it'],
        handoff: '## research\nFound it.\n',
        answers: ['Use the old way.', 'Mind the cache.'],
        returns: ['## code-review\nFix the name.'],
        findings: ['checks\nLint\nunused import'],
        instruction: 'replay it',
      }),
    );

    git(clone, ['commit', '--allow-empty', '-m', 'next']);
    expect(await readVisitInput(deps, run, 'implement', 'replay it')).not.toBe(read);
  });

  it('gives a new digest for a new stored answer and a new chat message', async () => {
    const { clone } = copyMainWithOrigin(root, 'main');
    const deps = { documents, worktrees: root };
    const target = { ...run, targetPath: clone };
    const first = await readVisitInput(deps, target, 'implement');

    stored.set(ARTIFACTS.answers.kind, 'Use the old way.');
    const answered = await readVisitInput(deps, target, 'implement');
    chat({ key: 'message-1', role: 'person', text: 'Mind the cache.', at: 't', state: 'taken' });
    const talked = await readVisitInput(deps, target, 'implement');

    expect(new Set([first, answered, talked]).size).toBe(3);
  });

  it('leaves out a document the step does not take', async () => {
    const { clone } = copyMainWithOrigin(root, 'main');
    const target = { ...run, targetPath: clone };
    const before = await readVisitInput({ documents, worktrees: root }, target, 'checks');
    stored.set(ARTIFACTS.answers.kind, 'Use the old way.');
    expect(await readVisitInput({ documents, worktrees: root }, target, 'checks')).toBe(before);
  });

  it("leaves the code-review input the same after a planner's answer and changes it on a new head or an added instruction", async () => {
    const { clone } = copyMainWithOrigin(root, 'main');
    const deps = { documents, worktrees: root };
    const target = { ...run, targetPath: clone };
    const first = await readVisitInput(deps, target, 'code-review');

    chat({ key: 'answer-1', role: 'planner', text: 'The return stands.', at: 't', state: 'taken', kind: 'answer' });
    stored.set(ARTIFACTS.answers.kind, 'Use the old way.');
    expect(await readVisitInput(deps, target, 'code-review')).toBe(first);

    expect(
      await readVisitInput(deps, { ...target, prompt: 'Build it.\n\nAlso mind the cache.' }, 'code-review'),
    ).not.toBe(first);
    git(clone, ['commit', '--allow-empty', '-m', 'next']);
    expect(await readVisitInput(deps, target, 'code-review')).not.toBe(first);
  });
});
