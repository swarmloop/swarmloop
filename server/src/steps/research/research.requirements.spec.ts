import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import type { Requirement } from '../../contract/requirement-list';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { ARTIFACTS } from '../contract/artifacts';
import { answer, boot, seed, writeEnv } from './research.step.spec-helpers';

const NINE: Requirement[] = Array.from({ length: 9 }, (_, index) => ({
  id: `R${index + 1}`,
  text: `item ${index + 1}`,
}));
const KIND = ARTIFACTS.requirementList.kind;

async function open(key: string, agent: jest.Mock) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-requirements-'));
  await writeEnv(root);
  const app = await boot(root, agent);
  await seed(app, root, key);
  return app;
}

/** A subtask of a parent with three tasks; `t1` covers R2 and R5. */
async function openSubtask(agent: jest.Mock, parentList: Requirement[] | null, stored?: Requirement[]) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-research-requirements-'));
  await writeEnv(root);
  mkdirSync(join(root, 'worktrees', 'PROJ-2-t1', 'billing-api'), { recursive: true });
  const app = await boot(root, agent);
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const parent = await runs.openWaiting('PROJ-2', '/target');
  if (parentList) await documents.putDocument(parent, KIND, ARTIFACTS.requirementList.format(parentList));
  const tasks = [
    { id: 't1', title: 'one', description: 'add the column', covers: ['R2', 'R5'], files: [], proof: 'p' },
  ];
  await documents.putDocument(parent, 'subtasks', JSON.stringify(tasks));
  const child = await runs.begin('PROJ-2-t1', 'prepare');
  child.status = 'waiting';
  child.currentStep = 'research';
  child.parentRunId = parent.id;
  child.taskId = 't1';
  await runs.saveRun(child);
  await documents.putDocument(child, 'requirements', '{"prompt":"add the column"}\n');
  if (stored) await documents.putDocument(child, KIND, ARTIFACTS.requirementList.format(stored));
  return { app, documents };
}

const storedList = async (app: Awaited<ReturnType<typeof boot>>, key: string): Promise<Requirement[] | null> => {
  const body = await app.get(DocumentRepository).latestBody(key, KIND);
  return body === null ? null : ARTIFACTS.requirementList.parse(body);
};

describe('research requirements', () => {
  it('stores nine requirements R1..R9 in order', async () => {
    const agent = jest.fn().mockResolvedValue(answer({ requirements: NINE }));
    const app = await open('PROJ-1', agent);
    try {
      await app.get(PipelineService).step('research', 'PROJ-1');
      expect((agent.mock.calls[0]?.[0] as AgentRunInput).prompt).toContain('- requirements (');
      expect(await storedList(app, 'PROJ-1')).toEqual(NINE);
    } finally {
      await app.close();
    }
  });

  it('stores one requirement for a single short request', async () => {
    const one = [{ id: 'R1', text: 'ship the field' }];
    const app = await open('PROJ-1', jest.fn().mockResolvedValue(answer({ requirements: one })));
    try {
      await app.get(PipelineService).step('research', 'PROJ-1');
      expect(await storedList(app, 'PROJ-1')).toEqual(one);
    } finally {
      await app.close();
    }
  });

  it('keeps R1..R9 on a rerun and adds R10', async () => {
    const added = [...NINE, { id: 'R10', text: 'the answered question' }];
    const app = await open('PROJ-1', jest.fn().mockResolvedValue(answer({ requirements: added })));
    try {
      await app
        .get(DocumentRepository)
        .putDocument((await app.get(RunRepository).findRun('PROJ-1'))!, KIND, ARTIFACTS.requirementList.format(NINE));
      await app.get(PipelineService).step('research', 'PROJ-1');
      expect(await storedList(app, 'PROJ-1')).toEqual(added);
    } finally {
      await app.close();
    }
  });

  it('sends the result follow-up to a rerun that renumbers', async () => {
    const agent = jest
      .fn()
      .mockResolvedValueOnce(answer({ requirements: [...NINE, { id: 'R12', text: 'skipped ahead' }] }))
      .mockResolvedValue(answer({ requirements: [...NINE, { id: 'R10', text: 'fixed' }] }));
    const app = await open('PROJ-1', agent);
    try {
      await app
        .get(DocumentRepository)
        .putDocument((await app.get(RunRepository).findRun('PROJ-1'))!, KIND, ARTIFACTS.requirementList.format(NINE));
      await app.get(PipelineService).step('research', 'PROJ-1');
      expect((agent.mock.calls[1]?.[0] as AgentRunInput).prompt).toContain('R12 is not the next requirement id');
      expect(await storedList(app, 'PROJ-1')).toHaveLength(10);
    } finally {
      await app.close();
    }
  });

  it('gives a subtask the parent entries its task covers plus T1, and no requirements field in its prompt', async () => {
    const agent = jest.fn().mockResolvedValue(answer());
    const { app } = await openSubtask(agent, NINE);
    try {
      await app.get(PipelineService).step('research', 'PROJ-2-t1');
      expect(await storedList(app, 'PROJ-2-t1')).toEqual([
        { id: 'R2', text: 'item 2' },
        { id: 'R5', text: 'item 5' },
        { id: 'T1', text: 'add the column' },
      ]);
      const prompt = (agent.mock.calls[0]?.[0] as AgentRunInput).prompt;
      expect(prompt).not.toContain('- requirements (');
      expect(prompt).not.toContain('requirements[].id');
    } finally {
      await app.close();
    }
  });

  it('keeps the stored list of a subtask on a later pass', async () => {
    const stored = [
      { id: 'R2', text: 'item 2' },
      { id: 'T1', text: 'add the column' },
    ];
    const { app } = await openSubtask(jest.fn().mockResolvedValue(answer()), NINE, stored);
    try {
      await app.get(PipelineService).step('research', 'PROJ-2-t1');
      expect(await storedList(app, 'PROJ-2-t1')).toEqual(stored);
    } finally {
      await app.close();
    }
  });

  it('stores no list for a subtask whose parent has none', async () => {
    const { app } = await openSubtask(jest.fn().mockResolvedValue(answer()), null);
    try {
      await app.get(PipelineService).step('research', 'PROJ-2-t1');
      expect(await storedList(app, 'PROJ-2-t1')).toBeNull();
    } finally {
      await app.close();
    }
  });
});
