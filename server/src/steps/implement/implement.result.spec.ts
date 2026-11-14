import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { DocumentRepository } from '../../history/document.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { RESULT_AS_BEFORE } from '../../agent-result/result-prompt';
import { resultAnswer } from '../../testing/result-answer';
import { handoffText } from '../shared/handoff';
import { boot, featureTree, implAnswer, result, seed, writeEnv } from './implement.step.spec-helpers';

const KINDS = ['implementation', 'implementation_result', 'implementation_improve_result', 'requirements', 'handoff'];

/** Runs the implement step of a run with an approved plan, one scripted answer per launch. */
async function implementWith(key: string, answers: string[], chat = false) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-result-'));
  await writeEnv(root);
  featureTree(root, key, 'billing-api');
  if (chat) {
    mkdirSync(join(root, 'data', 'agent-state', key, 'implement'), { recursive: true });
    writeFileSync(
      join(root, 'data', `${key}-implement-session.json`),
      `${JSON.stringify({ runtime: 'cursor', chatId: 'implement-chat', resumed: true, completed: true, killReason: null, usd: 1 })}\n`,
    );
  }
  const agent = jest.fn();
  for (const answer of answers) agent.mockResolvedValueOnce(result(answer));
  const app = await boot(root, agent);
  try {
    await seed(app, key, 'approve');
    const done = await app.get(PipelineService).step('implement', key);
    const documents = app.get(DocumentRepository);
    const stored: Record<string, string | null> = {};
    for (const kind of KINDS) stored[kind] = await documents.latestBody(key, kind);
    return {
      done,
      prompts: agent.mock.calls.map((call) => (call[0] as AgentRunInput).prompt),
      body: (kind: string) => stored[kind] ?? null,
    };
  } finally {
    await app.close();
  }
}

describe('implement step result block', () => {
  it('stores the same implementation document the prose answer gave, and the object next to it', async () => {
    const out = await implementWith('PROJ-400', [
      implAnswer(['changed the field parser', 'ran unit tests'], ['changed the parser so empty fields stay']),
    ]);
    expect(out.done.exitCode).toBe(0);
    expect(out.body('implementation')).toBe('- changed the field parser\n- ran unit tests\n');
    expect(JSON.parse(out.body('implementation_result') ?? '{}')).toEqual({
      implementation: ['changed the field parser', 'ran unit tests'],
      summary: ['changed the parser so empty fields stay'],
      plan: ['add the field'],
    });
    expect(handoffText(out.body('handoff'))).toBe('## implement\n- changed the parser so empty fields stay\n');
  });

  it('stores an item with colons, nested lines, blank lines and code whole', async () => {
    const item = 'Changed it:\n- nested: yes\n  - deeper\n1. first\n\n```ts\nconst a = { b: 1 };\n```';
    const out = await implementWith('PROJ-401', [implAnswer([item], ['why'])]);
    expect(JSON.parse(out.body('implementation_result') ?? '{}').implementation).toEqual([item]);
    expect(out.body('implementation')).toContain('  const a = { b: 1 };');
  });

  it('asks again with every error and passes when the second answer is fixed', async () => {
    const out = await implementWith('PROJ-402', [
      resultAnswer('Done.', { implementation: 'one string' }),
      implAnswer(['fixed it'], ['why']),
    ]);
    expect(out.done.exitCode).toBe(0);
    expect(out.prompts).toHaveLength(2);
    expect(out.prompts[1]).toContain('implementation');
    expect(out.prompts[1]).toContain('summary');
    expect(out.prompts[1]).toContain(RESULT_AS_BEFORE);
    expect(out.body('implementation')).toBe('- fixed it\n');
  });

  it('fails the step with the errors after a third invalid answer', async () => {
    const bad = implAnswer([], ['why']);
    const out = await implementWith('PROJ-403', [bad, bad, bad]);
    expect(out.done.exitCode).toBe(1);
    expect(out.done.message).toContain('implementation: must list what you changed');
    expect(out.prompts).toHaveLength(3);
    expect(out.body('implementation')).toBeNull();
  });

  it('sends the full result text in the first prompt of a chat and one line in the second', async () => {
    const first = await implementWith('PROJ-404', [implAnswer(['a'], ['why'])]);
    expect(first.prompts[0]).toContain('The object has these fields, and no others:');
    const second = await implementWith('PROJ-405', [implAnswer(['a'], ['why'])], true);
    expect(second.prompts[0]).toContain(RESULT_AS_BEFORE);
    expect(second.prompts[0]).not.toContain('The object has these fields, and no others:');
  });

  it('takes the corrected checklist and the cause from the object', async () => {
    const out = await implementWith('PROJ-406', [
      implAnswer(['fixed the test'], ['the log required it'], {
        plan: ['fix the failing test'],
        cause: ['the parser dropped the suffix'],
      }),
    ]);
    const record = JSON.parse(out.body('requirements') ?? '{}') as { plan: { items: string[] } };
    expect(record.plan.items).toEqual(['fix the failing test']);
    const handoff = handoffText(out.body('handoff')) ?? '';
    expect(handoff).toContain('cause:\n- the parser dropped the suffix');
    expect(handoff).toContain('dropped "add the field"');
    expect(JSON.parse(out.body('implementation_result') ?? '{}').plan).toEqual(['fix the failing test']);
  });
});
