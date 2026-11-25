import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Joi from 'joi';
import { reviewReport } from '../../agent-result/definitions/review-report';
import { CODE_REVIEWERS } from '../../contract/steps';
import { defineResult } from '../../agent-result/result-definition';
import type { AgentProcessRunner, AgentRunInput } from '../../agent/agent-runner';
import { RunStop } from '../../agent/run-stop';
import type { RunEntity } from '../../history/entities';
import type { VisitRepository } from '../../history/visit.repository';
import { AgentLauncher } from './agent-launcher';
import type { AgentLaunchRequest } from './agent-launch-request';
import { ResultInvalid } from './answer-errors';
import { ModelHostUnavailable } from './model-host-unavailable';
import { emptyResult } from '../../agent/agent-result';
import type { AgentRunResult } from '../../agent/agent-result';
import type { KillReason } from '../../agent/limits';
import { HOST_RETRY_MS } from '../../integrations/http';
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
function launcherOf(answers: ScriptedAnswer[], step = 'plan') {
  const runner = new BlockAgentRunner({ [step]: answers });
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

  it('sends a follow-up naming the error of a report with six done items, and passes a fixed second answer', async () => {
    const report = (done: string[]): ScriptedAnswer => ({
      block: {
        line: 'The field ships.',
        done,
        worthALook: [],
        notes: Object.fromEntries(CODE_REVIEWERS.map((name) => [name, 'ok'])),
        risk: 'low',
        riskReason: 'small',
      },
    });
    const { launcher, prompts } = launcherOf(
      [report(['1', '2', '3', '4', '5', '6']), report(['1', '2', '3', '4', '5'])],
      'code-review-report',
    );
    const launched = await launcher.launch(requestOf({ step: 'code-review-report', result: reviewReport }));
    expect(prompts()[1]).toContain('done');
    expect(prompts()[1]).toContain('must contain less than or equal to 5 items');
    expect((launched.resultValue as { done: string[] }).done).toHaveLength(5);
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
    expect(prompts()[1]).toContain('- items (array of string, required)');
    expect(prompts()[1]).toContain('Send the result block again and change nothing else.');
  });

  it('shows the part of a wrong field in the follow-up', async () => {
    const { launcher, prompts } = launcherOf([{ block: { items: ['a'], decision: 'maybe' } }, ok()]);
    await launcher.launch(requestOf());
    expect(prompts()[1]).toContain('- decision (one of "ok", "return", required)');
    expect(prompts()[1]).not.toContain('FULL PROMPT');
  });

  it('shows the part of the definition under a stored error, in the same chat and in a fresh one', async () => {
    const { launcher, prompts, fresh } = launcherOf([ok()]);
    await launcher.launch(requestOf({ answerErrors: ['decision: "decision" must be one of [ok, return]'] }));
    expect(prompts()[0]).toContain('- decision (one of "ok", "return", required)');
    expect(fresh()).toContain('- decision (one of "ok", "return", required)');
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

const OUTAGE = { host: 'api.anthropic.com', detail: 'API Error: 502 ENOTFOUND api.anthropic.com' };
const FINISHED = '2026-11-25T10:00:00.000Z';

/** A launch that ends because the model host did not answer, with the cost of its try. */
function outageTry(killReason: KillReason | null = null): AgentRunResult {
  return {
    ...emptyResult(killReason ?? 'time', 0, 1, FINISHED),
    killReason,
    usd: 0.5,
    tokensIn: 7,
    outage: OUTAGE,
  };
}

/** A launcher over a runner that returns these results in order, and the prompts it saw. */
function launcherOfResults(results: AgentRunResult[]) {
  const prompts: string[] = [];
  const agent = {
    run: (input: AgentRunInput) => {
      prompts.push(input.prompt);
      const next = results.shift();
      return next ? Promise.resolve(next) : Promise.reject(new Error('unexpected launch'));
    },
  } as unknown as AgentProcessRunner;
  const visits = { tokenTotal: jest.fn().mockResolvedValue(0) } as unknown as VisitRepository;
  return { launcher: new AgentLauncher(agent, visits, new RunStop()), prompts };
}

describe('AgentLauncher model host outage', () => {
  it("throws ModelHostUnavailable with the host, its next try and the try's cost, and sends no follow-up", async () => {
    const { launcher, prompts } = launcherOfResults([outageTry()]);
    const failure = (await launcher.launch(requestOf()).catch((error: unknown) => error)) as ModelHostUnavailable;
    expect(failure).toBeInstanceOf(ModelHostUnavailable);
    expect(failure.host).toBe(OUTAGE.host);
    expect(failure.detail).toBe(OUTAGE.detail);
    expect(failure.retryAt).toBe(new Date(Date.parse(FINISHED) + HOST_RETRY_MS).toISOString());
    expect(failure.result.usd).toBe(0.5);
    expect(prompts).toHaveLength(1);
  });

  it('throws it with the cost of both tries when a follow-up ends with an outage', async () => {
    const { launcher, prompts } = launcherOfResults([
      {
        ...emptyResult('time', 0, 1, FINISHED),
        killReason: null,
        usd: 0.25,
        tokensIn: 3,
        responseText: 'I wrote the plan.',
      },
      outageTry(),
    ]);
    const failure = (await launcher.launch(requestOf()).catch((error: unknown) => error)) as ModelHostUnavailable;
    expect(failure).toBeInstanceOf(ModelHostUnavailable);
    expect(failure.result.usd).toBe(0.75);
    expect(failure.result.tokensIn).toBe(10);
    expect(prompts).toHaveLength(2);
  });

  it('throws it for a launch killed by idle whose end reads an outage', async () => {
    const { launcher, prompts } = launcherOfResults([outageTry('idle')]);
    const failure = await launcher.launch(requestOf()).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelHostUnavailable);
    expect((failure as ModelHostUnavailable).result.killReason).toBe('idle');
    expect(prompts).toHaveLength(1);
  });
});
