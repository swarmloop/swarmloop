import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { ARTIFACTS } from '../contract/artifacts';
import { storedImpact } from '../shared/research-reads';
import { answer, boot, research, result, seed, writeEnv } from './research.step.spec-helpers';
import { renderImpact } from './research-record';

const IMPACT = [
  { capability: 'stop button', file: 'stop.tsx', status: 'kept' },
  { capability: 'live agent log', file: 'step-documents.tsx', status: 'removed (named)' },
];
const BAD = { impact: [{ capability: 'a', file: 'f', status: 'maybe' }] };

async function open(key: string, agent: jest.Mock) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-result-'));
  await writeEnv(root);
  const app = await boot(root, agent);
  await seed(app, root, key);
  return app;
}

describe('research result', () => {
  it('stores the same questions and impact as the prose reader did for the same content', async () => {
    const agent = jest
      .fn()
      .mockResolvedValue(answer({ questions: ['which field is optional?', 'which limit?'], impact: IMPACT }));
    const app = await open('PROJ-60', agent);
    try {
      await app.get(PipelineService).step('research', 'PROJ-60');
      const documents = app.get(DocumentRepository);
      expect(await documents.latestBody('PROJ-60', 'questions')).toBe('- which field is optional?\n- which limit?\n');
      expect(await documents.latestBody('PROJ-60', 'impact')).toBe(
        '- stop button | stop.tsx | kept\n- live agent log | step-documents.tsx | removed (named)\n',
      );
    } finally {
      await app.close();
    }
  });

  it('stores a question and an impact line with colons, lists, numbers, blank lines and code whole', async () => {
    const text = 'Is a: b ok?\n  - nested: item\n1. first\n\n```ts\nconst a = { b: 1 };\n```';
    const value = research({ questions: [text], impact: [{ capability: text, file: 'a: b.ts', status: 'changed' }] });
    const app = await open('PROJ-61', jest.fn().mockResolvedValue(answer(value)));
    try {
      await app.get(PipelineService).step('research', 'PROJ-61');
      const body = await app.get(DocumentRepository).latestBody('PROJ-61', ARTIFACTS.researchResult.kind);
      expect(ARTIFACTS.researchResult.parse(body ?? '')).toEqual(value);
    } finally {
      await app.close();
    }
  });

  it('sends every error back, and goes on with the block of the second answer', async () => {
    const agent = jest
      .fn()
      .mockResolvedValueOnce(answer(BAD))
      .mockResolvedValue(answer({ summary: ['fixed'] }));
    const app = await open('PROJ-62', agent);
    try {
      const done = await app.get(PipelineService).step('research', 'PROJ-62');
      expect(done.exitCode).toBe(0);
      expect(agent).toHaveBeenCalledTimes(2);
      expect((agent.mock.calls[1]?.[0] as AgentRunInput).prompt).toContain('impact.0.status');
      const stored = await app.get(DocumentRepository).latestBody('PROJ-62', ARTIFACTS.researchResult.kind);
      expect(stored).toContain('fixed');
      expect((await app.get(RunRepository).findRun('PROJ-62'))?.currentStep).toBe('plan');
    } finally {
      await app.close();
    }
  });

  it('fails the step with the errors after a third invalid answer', async () => {
    const agent = jest.fn().mockResolvedValueOnce(answer(BAD)).mockResolvedValueOnce(answer(BAD));
    agent.mockResolvedValue(result('no block at all'));
    const app = await open('PROJ-63', agent);
    try {
      const done = await app.get(PipelineService).step('research', 'PROJ-63');
      expect(done.exitCode).toBe(1);
      expect(done.message).toContain('the answer has no result block');
      expect(agent).toHaveBeenCalledTimes(3);
      expect((await app.get(RunRepository).findRun('PROJ-63'))?.currentStep).toBe('research');
    } finally {
      await app.close();
    }
  });

  it('writes the wait and the result for a subtask that needs a sibling', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-result-'));
    await writeEnv(root);
    const needs = [{ id: 't0', what: 'the retry policy' }];
    const app = await boot(root, jest.fn().mockResolvedValue(answer({ needs })));
    await seed(app, root, 'PROJ-64-t1');
    const runs = app.get(RunRepository);
    const child = (await runs.findRun('PROJ-64-t1'))!;
    child.parentRunId = (await runs.openWaiting('PROJ-64', '/target')).id;
    child.taskId = 't1';
    await runs.saveRun(child);
    try {
      await app.get(PipelineService).step('research', 'PROJ-64-t1');
      const documents = app.get(DocumentRepository);
      expect(await documents.latestBody('PROJ-64-t1', 'needs')).toBe('needs:\n- t0: the retry policy\n');
      const stored = await documents.latestBody('PROJ-64-t1', ARTIFACTS.researchResult.kind);
      expect(ARTIFACTS.researchResult.parse(stored ?? '')).toMatchObject({ needs });
      expect((await runs.findRun('PROJ-64-t1'))?.currentStep).toBe('research');
    } finally {
      await app.close();
    }
  });
});

describe('storedImpact', () => {
  it('renders the impact of the result, whatever the old document says', () => {
    expect(storedImpact(research({ impact: IMPACT }) as never, '- old | f | kept\n')).toBe(renderImpact(IMPACT));
  });

  it('keeps the old document for a run that has no result', () => {
    expect(storedImpact(null, '- old | f | kept\n')).toBe('- old | f | kept\n');
    expect(storedImpact(null, null)).toBeNull();
  });
});
