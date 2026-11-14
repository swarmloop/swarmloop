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
import { RunRepository } from '../../history/run.repository';
import { ARTIFACTS } from '../contract/artifacts';
import { boot, featureTree, result, writeEnv } from './implement.step.spec-helpers';

const improved = (value: Record<string, unknown>): string => resultAnswer('Done.', value);

/** A run at implement-improve with an approved plan and the `implementation` document of a first pass. */
async function seedFirstPass(app: Awaited<ReturnType<typeof boot>>, key: string) {
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const seeded = await runs.begin(key, 'implement-improve');
  seeded.status = 'waiting';
  seeded.currentStep = 'implement-improve';
  await runs.saveRun(seeded);
  const plan = { name: '', overview: '', items: ['add the field'], decision: 'approve' };
  await documents.putDocument(seeded, 'requirements', `${JSON.stringify({ prompt: 'Ship the field\n', plan })}\n`);
  await documents.putDocument(seeded, 'repos', 'billing-api\n');
  await documents.putDocument(seeded, 'implementation', '- changed the field parser\n');
  return seeded;
}

const KINDS = ['implementation', 'implementation_result', 'implementation_improve_result', 'handoff'];

/** Runs implement-improve over a first pass, one scripted answer per launch. */
async function improveWith(key: string, answers: string[], chat = false) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-improve-result-'));
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
    const documents = app.get(DocumentRepository);
    const run = await seedFirstPass(app, key);
    if (chat) {
      // The chat's last answer was an implement-improve result, which is written after the implement result.
      const first = { implementation: ['changed the field parser'], summary: [] };
      await documents.putDocument(
        run,
        ARTIFACTS.implementationResult.kind,
        ARTIFACTS.implementationResult.format(first),
      );
      await documents.putDocument(
        run,
        ARTIFACTS.implementationImproveResult.kind,
        ARTIFACTS.implementationImproveResult.format({ summary: [] }),
      );
    }
    const done = await app.get(PipelineService).step('implement-improve', key);
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

describe('implement-improve step result block', () => {
  it('stores the improved items as the implementation document and as the implementation result', async () => {
    const out = await improveWith('PROJ-410', [
      improved({ implementation: ['fixed the empty case'], summary: ['why'] }),
    ]);
    expect(out.done.exitCode).toBe(0);
    expect(out.body('implementation')).toBe('- fixed the empty case\n');
    expect(JSON.parse(out.body('implementation_result') ?? '{}')).toEqual({
      implementation: ['fixed the empty case'],
      summary: ['why'],
      plan: ['add the field'],
    });
    expect(JSON.parse(out.body('implementation_improve_result') ?? '{}').summary).toEqual(['why']);
  });

  it('keeps the first pass when the answer has an empty implementation', async () => {
    const out = await improveWith('PROJ-411', [improved({ implementation: [], summary: ['nothing to fix'] })]);
    expect(out.body('implementation')).toBe('- changed the field parser\n');
    expect(handoffText(out.body('handoff'))).toBe('## implement-improve\n- nothing to fix\n');
  });

  it('fails the step with the errors after a third invalid answer', async () => {
    const bad = improved({ implementation: ['x'] });
    const out = await improveWith('PROJ-412', [bad, bad, bad]);
    expect(out.done.exitCode).toBe(1);
    expect(out.done.message).toContain('summary');
    expect(out.prompts).toHaveLength(3);
  });

  it('sends one line for the result in the second prompt of a chat that received it', async () => {
    const first = await improveWith('PROJ-413', [improved({ summary: ['ok'] })]);
    expect(first.prompts[0]).toContain('The object has these fields, and no others:');
    const second = await improveWith('PROJ-414', [improved({ summary: ['ok'] })], true);
    expect(second.prompts[0]).toContain(RESULT_AS_BEFORE);
    expect(second.prompts[0]).not.toContain('The object has these fields, and no others:');
  });
});
