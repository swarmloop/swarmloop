import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunRepository } from '../../history/run.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { AgentRunInput } from '../../agent/agent-runner';
import { PipelineService } from '../../pipeline/pipeline.service';
import { implAnswer, result, boot, seed, writeEnv, featureTree } from './implement.step.spec-helpers';

describe('implement step answering a code review', () => {
  const REJECTED = [{ reviewer: 'quality', finding: 'Use theme.alpha', reason: 'The theme has no alpha here.' }];

  async function pass(key: string, returned: string, answer: string) {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-implement-review-answer-'));
    await writeEnv(root);
    const worktree = featureTree(root, key, 'billing-api');
    const agent = jest.fn(async () => {
      writeFileSync(join(worktree, 'field.ts'), 'export const field = 2;\n');
      return result(answer);
    });
    const app = await boot(root, agent);
    await seed(app, key, 'approve');
    const run = await app.get(RunRepository).findRun(key);
    await app.get(DocumentRepository).putDocument(run!, 'return', returned);
    const done = await app.get(PipelineService).step('implement', key);
    expect(done.exitCode).toBe(0);
    return { app, prompt: (agent.mock.calls[0] as unknown as [AgentRunInput])[0].prompt };
  }

  it('asks for the findings it does not fix after a code review return, and stores them', async () => {
    const { app, prompt } = await pass(
      'PROJ-150',
      '## quality\nUse theme.alpha\n',
      implAnswer(['kept the colors'], ['kept'], { rejected: REJECTED }),
    );
    try {
      expect(prompt).toContain('For each finding of this code review you do not fix, add an entry to `rejected`');
      expect(prompt).toContain('- rejected (array of object, optional)');
      const stored = JSON.parse((await app.get(DocumentRepository).latestBody('PROJ-150', 'implementation_result'))!);
      expect(stored.rejected).toEqual(REJECTED);
    } finally {
      await app.close();
    }
  });

  it.each([
    ['a checks return', '## checks\nlint failed\n'],
    ['a pipeline return', '## pipeline\nresult: fail\njob: test\n\nAssertion failed\n'],
  ])('does not ask for them after %s', async (name, returned) => {
    const { app, prompt } = await pass(`PROJ-15${name.length}`, returned, implAnswer(['fixed it'], ['fixed']));
    try {
      expect(prompt).not.toContain('`rejected`');
      expect(prompt).not.toContain('- rejected (');
    } finally {
      await app.close();
    }
  });
});
