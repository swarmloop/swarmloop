import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { AgentRunInput } from '../../agent/agent-runner';
import { DocumentRepository } from '../../history/document.repository';
import { PlanChatStore } from '../../history/plan-chat.store';
import { RunRepository } from '../../history/run.repository';
import { PipelineService } from '../../pipeline/pipeline.service';
import { resultAnswer } from '../../testing/result-answer';
import { planChatFollowUp } from './plan.prompts';
import { readPlan, withPlan } from './plan-record';
import { boot, planBlock, result, seed, writeChat, writeEnv } from './plan.step.spec-helpers';

const KEY = 'PROJ-60';
const OLD = ['add the field - files: a.ts - proof: a.spec.ts'];
const NEW = ['add the field and its index - files: a.ts - proof: a.spec.ts'];

const reply = (value: Record<string, unknown>) => result(resultAnswer('Done.', value));
const message = (text: string, key = 'message-1', at = '2026-11-17T09:00:00.000Z') => ({
  key,
  role: 'person' as const,
  author: 'ana',
  text,
  at,
  state: 'pending' as const,
});

/** A run whose plan is stored and approved, with the plan chat the first visit left, and the agent's next answers. */
async function planned(answers: ReturnType<typeof result>[], options: { chat?: boolean; plan?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'swarmloop-plan-chat-'));
  await writeEnv(root);
  mkdirSync(join(root, 'worktrees', KEY, 'billing-api'), { recursive: true });
  if (options.chat !== false) writeChat(root, KEY);
  const agent = jest.fn();
  for (const answer of answers) agent.mockResolvedValueOnce(answer);
  const app = await boot(root, agent);
  await seed(app, KEY, '');
  const runs = app.get(RunRepository);
  const documents = app.get(DocumentRepository);
  const run = (await runs.findRun(KEY))!;
  if (options.plan !== false) {
    await documents.putDocument(
      run,
      'requirements',
      withPlan('{"prompt":"ship the field"}\n', { name: '', overview: '', items: OLD, decision: 'approve' }),
    );
  }
  await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
  await documents.putDocument(
    run,
    'requirement_coverage',
    `${JSON.stringify([{ id: 'R1', text: 'ship the field', items: OLD }])}\n`,
  );
  const store = app.get(PlanChatStore);
  const planBody = async () => readPlan((await documents.latestBody(KEY, 'requirements')) ?? '');
  const launched = (index: number) => agent.mock.calls[index]?.[0] as AgentRunInput;
  return {
    app,
    agent,
    store,
    documents,
    runs,
    planBody,
    launched,
    step: () => app.get(PipelineService).step('plan', KEY),
  };
}

describe('plan step with a person message', () => {
  it('continues its own chat with the message and the plan reply, and records the revision', async () => {
    const flow = await planned([reply({ reply: 'Added an index.', summary: ['index'], plan: NEW, covers: [['R1']] })]);
    try {
      await flow.store.appendEntry(KEY, message('Please add an index too'));
      await flow.step();
      const input = flow.launched(0);
      expect(input.mode).toBe('plan');
      expect(input.prompt).toContain('Please add an index too');
      expect(input.prompt).toContain('- reply (string, required)');
      const log = await flow.store.read(KEY);
      expect(log.entries.map((entry) => [entry.role, entry.state, entry.version])).toEqual([
        ['person', 'taken', undefined],
        ['planner', 'taken', 2],
      ]);
      expect(log.entries[1].text).toBe('Added an index.');
      expect(log.revisions).toMatchObject([{ version: 2, reason: 'Please add an index too', changed: NEW }]);
      expect((await flow.planBody())?.items).toEqual(NEW);
      expect((await flow.planBody())?.decision).toBeNull();
      expect((await flow.runs.findRun(KEY))?.currentStep).toBe('plan-improve');
    } finally {
      await flow.app.close();
    }
  });

  it('keeps the plan for a reply with no plan, takes the message and goes on', async () => {
    const flow = await planned([reply({ reply: 'It already does that.' })]);
    try {
      await flow.store.appendEntry(KEY, message('Does it cover the empty case?'));
      await flow.step();
      expect((await flow.planBody())?.items).toEqual(OLD);
      expect((await flow.planBody())?.decision).toBe('approve');
      const log = await flow.store.read(KEY);
      expect(log.revisions).toEqual([]);
      expect(log.entries.map((entry) => [entry.role, entry.version])).toEqual([
        ['person', undefined],
        ['planner', undefined],
      ]);
      expect(await flow.store.pending(KEY)).toEqual([]);
      expect((await flow.runs.findRun(KEY))?.currentStep).toBe('branch');
    } finally {
      await flow.app.close();
    }
  });

  it('adds a new requirement under the next id, and asks once more for a plan that does not cover it', async () => {
    const flow = await planned([
      reply({ reply: 'Added.', requirements: ['keep the old rows'], summary: ['s'], plan: NEW, covers: [['R1']] }),
      reply({
        reply: 'Covered.',
        summary: ['s'],
        plan: [...NEW, 'keep rows - files: b.ts - proof: b.spec.ts'],
        covers: [['R1'], ['R2']],
      }),
    ]);
    try {
      await flow.store.appendEntry(KEY, message('Also keep the old rows'));
      await flow.step();
      expect(flow.agent).toHaveBeenCalledTimes(2);
      expect(flow.launched(1).prompt).toContain('R2 is not covered: keep the old rows');
      expect(JSON.parse((await flow.documents.latestBody(KEY, 'requirement_list')) ?? '[]')).toEqual([
        { id: 'R1', text: 'ship the field' },
        { id: 'R2', text: 'keep the old rows' },
      ]);
      expect((await flow.planBody())?.items).toHaveLength(2);
    } finally {
      await flow.app.close();
    }
  });

  it('takes a message that came in while a visit ran with the next visit, in the same chat', async () => {
    const flow = await planned([]);
    try {
      await flow.store.appendEntry(KEY, message('alpha words', 'message-1', '2026-11-17T09:00:00.000Z'));
      flow.agent.mockImplementationOnce(async () => {
        await flow.store.appendEntry(KEY, message('beta words', 'message-2', '2026-11-17T09:00:05.000Z'));
        return reply({ reply: 'First.', summary: ['s'], plan: NEW, covers: [['R1']] });
      });
      await flow.step();
      expect((await flow.store.pending(KEY)).map((entry) => entry.key)).toEqual(['message-2']);
      flow.agent.mockResolvedValueOnce(reply({ reply: 'Second.' }));
      await flow.step();
      expect(flow.launched(1).prompt).toContain('beta words');
      expect(flow.launched(1).prompt).not.toContain('alpha words');
      expect(await flow.store.pending(KEY)).toEqual([]);
    } finally {
      await flow.app.close();
    }
  });

  it('leaves a message pending while the plan has no chat yet, and goes on with the stored plan', async () => {
    const flow = await planned([], { chat: false });
    try {
      await flow.store.appendEntry(KEY, message('hello'));
      await flow.step();
      expect(flow.agent).not.toHaveBeenCalled();
      expect((await flow.store.pending(KEY)).map((entry) => entry.key)).toEqual(['message-1']);
      expect((await flow.runs.findRun(KEY))?.currentStep).toBe('plan-improve');
    } finally {
      await flow.app.close();
    }
  });

  it('makes the first plan even when a message waits and the chat already exists', async () => {
    const flow = await planned([result(planBlock(NEW, { covers: [['R1']] }))], { plan: false });
    try {
      await flow.store.appendEntry(KEY, message('hello'));
      await flow.step();
      expect(flow.launched(0).prompt).not.toContain('- reply (string');
      expect((await flow.planBody())?.items).toEqual(NEW);
      expect((await flow.store.pending(KEY)).map((entry) => entry.key)).toEqual(['message-1']);
    } finally {
      await flow.app.close();
    }
  });

  it('gives a plan visit without a message the plan definition, as before', async () => {
    const flow = await planned([result(planBlock(NEW, { covers: [['R1']] }))]);
    try {
      const run = (await flow.runs.findRun(KEY))!;
      await flow.documents.putDocument(
        run,
        'requirements',
        withPlan('{"prompt":"ship the field"}\n', { name: '', overview: '', items: OLD, decision: 'revise' }),
      );
      await flow.step();
      expect(flow.launched(0).prompt).not.toContain('- reply (string');
      expect((await flow.planBody())?.items).toEqual(NEW);
    } finally {
      await flow.app.close();
    }
  });
});

describe('plan-improve with a person message', () => {
  const approved = async (pending: boolean) => {
    const flow = await planned([result(resultAnswer('Done.', { summary: ['checked'], plan: [] }))]);
    if (pending) await flow.store.appendEntry(KEY, message('wait'));
    await flow.app.get(PipelineService).step('plan-improve', KEY);
    return flow;
  };

  it('goes back to plan when it ends ok with a message waiting', async () => {
    const flow = await approved(true);
    try {
      expect((await flow.runs.findRun(KEY))?.currentStep).toBe('plan');
    } finally {
      await flow.app.close();
    }
  });

  it('goes on to branch when no message waits', async () => {
    const flow = await approved(false);
    try {
      expect((await flow.runs.findRun(KEY))?.currentStep).toBe('branch');
    } finally {
      await flow.app.close();
    }
  });
});

describe('planChatFollowUp', () => {
  it('holds the messages as the person words and ends with the result prompt', () => {
    const text = planChatFollowUp([{ text: ' one ' }, { text: 'two' }], 'RESULT PROMPT');
    expect(text).toContain("The person's words:\none\n\ntwo");
    expect(text).toContain('Change the plan only when the message asks for a change');
    expect(text.trimEnd().endsWith('RESULT PROMPT')).toBe(true);
  });
});
