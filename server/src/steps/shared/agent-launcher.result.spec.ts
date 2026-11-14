import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Joi from 'joi';
import { defineResult } from '../../agent-result/result-definition';
import type { AgentProcessRunner, AgentRunInput } from '../../agent/agent-runner';
import { RunStop } from '../../agent/run-stop';
import type { RunEntity } from '../../history/entities';
import type { VisitRepository } from '../../history/visit.repository';
import { AgentLauncher } from './agent-launcher';
import type { AgentLaunchRequest } from './agent-launch-request';
import { ResultInvalid } from './answer-errors';
import { BlockAgentRunner } from '../../testing/result-answer';
import type { ScriptedAnswer } from '../../testing/result-answer';

const definition = defineResult(
  'sample',
  Joi.object({
    items: Joi.array().items(Joi.string()).required(),
    decision: Joi.string().valid('ok', 'return').required(),
  }),
);
const ok = (items: string[] = ['a']): ScriptedAnswer => ({ block: { items, decision: 'ok' } });
const prose: ScriptedAnswer = { text: 'I wrote the plan.' };

/** A launcher over a runner that answers from a script, and the runner that recorded the prompts. */
function launcherOf(answers: ScriptedAnswer[]) {
  const runner = new BlockAgentRunner({ plan: answers });
  const agent = { run: (input: AgentRunInput) => runner.run(input) } as unknown as AgentProcessRunner;
  const visits = { tokenTotal: jest.fn().mockResolvedValue(0) } as unknown as VisitRepository;
  const prompts = (): string[] => runner.prompts.map((entry) => entry.prompt);
  return {
    launcher: new AgentLauncher(agent, visits, new RunStop()),
    prompts,
    fresh: () => runner.prompts[0].freshPrompt,
  };
}

function requestOf(extra: Partial<AgentLaunchRequest> = {}): AgentLaunchRequest {
  return {
    root: mkdtempSync(join(tmpdir(), 'swarmloop-result-')),
    run: { id: 1, key: 'K-1', agentCalls: 0, spentUsd: 0, activeAttempt: null } as unknown as RunEntity,
    key: 'K-1',
    step: 'plan',
    mode: 'agent',
    tools: 'all' as AgentLaunchRequest['tools'],
    runtime: 'cursor',
    model: 'm',
    timeLimitMs: 1000,
    prompt: 'FULL PROMPT with the schema, the skill and the rules',
    workspace: '/work/x',
    mounts: [],
    result: definition,
    ...extra,
  };
}

describe('AgentLauncher result', () => {
  it('passes a valid block on the first answer and returns its value', async () => {
    const { launcher, prompts } = launcherOf([ok()]);
    const launched = await launcher.launch(requestOf());
    expect(launched.resultValue).toEqual({ items: ['a'], decision: 'ok' });
    expect(prompts()).toHaveLength(1);
  });

  it('sends a follow-up for a prose-only answer, and passes a fixed block on the second answer', async () => {
    const { launcher, prompts } = launcherOf([prose, ok(['fixed'])]);
    const launched = await launcher.launch(requestOf());
    expect(launched.resultValue).toEqual({ items: ['fixed'], decision: 'ok' });
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toContain('no result block');
    expect(launched.tokensIn).toBe(20);
  });

  it('throws ResultInvalid with every error of the last answer after two follow-ups', async () => {
    const wrong: ScriptedAnswer = { block: { items: 'x', decision: 'maybe' } };
    const { launcher, prompts } = launcherOf([prose, wrong, wrong]);
    const failure = await launcher.launch(requestOf()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ResultInvalid);
    expect((failure as ResultInvalid).errors).toEqual([
      expect.stringContaining('items: "items" must be an array'),
      expect.stringContaining('decision: "decision" must be one of [ok, return]'),
    ]);
    expect(prompts()).toHaveLength(3);
  });

  it('puts the error of a failed check into the follow-up', async () => {
    const check = (value: unknown): string[] =>
      (value as { items: string[] }).items.length < 2 ? ['items: need at least two'] : [];
    const { launcher, prompts } = launcherOf([ok(['one']), ok(['one', 'two'])]);
    const launched = await launcher.launch(requestOf({ check }));
    expect(prompts()[1]).toContain('- items: need at least two');
    expect(launched.resultValue).toEqual({ items: ['one', 'two'], decision: 'ok' });
  });

  it('keeps the schema, the skill and the rules out of the follow-up', async () => {
    const { launcher, prompts } = launcherOf([prose, ok()]);
    await launcher.launch(requestOf());
    expect(prompts()[1]).not.toContain('FULL PROMPT');
    expect(prompts()[1]).not.toContain('items (');
    expect(prompts()[1]).toContain('Send the result block again and change nothing else.');
  });

  it('starts a relaunch with the stored errors in the same chat, and the full prompt with them in a fresh chat', async () => {
    const { launcher, prompts, fresh } = launcherOf([ok()]);
    await launcher.launch(requestOf({ answerErrors: ['items: "items" is required'] }));
    expect(prompts()[0]).toContain('- items: "items" is required');
    expect(prompts()[0]).toContain('FULL PROMPT');
    expect(fresh()).toContain('FULL PROMPT');
    expect(fresh()).toContain('- items: "items" is required');
  });

  it('sends the full prompt with the errors when the step starts every chat fresh', async () => {
    const { launcher, prompts } = launcherOf([ok()]);
    await launcher.launch(requestOf({ answerErrors: ['items: bad'], resume: false }));
    expect(prompts()[0]).toContain('FULL PROMPT');
    expect(prompts()[0]).toContain('- items: bad');
  });
});
