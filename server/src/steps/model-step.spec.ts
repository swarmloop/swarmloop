import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { RunStop } from '../agent/run-stop';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import type { AgentRunInput, AgentRunResult } from '../agent/agent-runner';
import { AgentLauncher } from './shared/agent-launcher';
import { goldenApp } from './shared/model-golden.spec-helpers';
import { StepKernel } from './step-kernel';
import { ResearchStep } from './research/research.step';
import type { StepResult } from './contract/step-contract';
import { ERROR_CODES } from '../contract/error-codes';
import { failedLaunches } from '../core/pipeline-result';
import { HostUnavailable, SwarmloopError } from '../core/swarmloop-error';
import { agentFailure, combineAgentResults } from './shared/agent-result';
import { modelVisit } from './shared/model-visit';
import { AGENT_FOREGROUND_RULE, AGENT_LANGUAGE_RULE, skillPrompt, workingDirectoryBlock } from './shared/skill-prompt';

describe('working directory block', () => {
  it('names the single scratch directory mounted at /work', () => {
    const text = workingDirectoryBlock(
      ['run-example'],
      [{ hostPath: '/tmp/run-example-missing', containerPath: '/work' }],
    );
    expect(text).toBe(
      [
        'The only working directory is /work (run-example). It has no source files.',
        'Do not look outside it. Do not open .git. Do not read the home directory, /opt, /proc, transcripts, or CLI files.',
      ].join('\n'),
    );
  });

  it('reports source files from the directory itself', () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-work-'));
    mkdirSync(join(root, 'empty'));
    mkdirSync(join(root, 'empty', '.git'));
    mkdirSync(join(root, 'full'));
    writeFileSync(join(root, 'full', 'readme.txt'), 'hello');
    const text = workingDirectoryBlock(
      ['empty', 'full'],
      [
        { hostPath: join(root, 'empty'), containerPath: '/work/empty' },
        { hostPath: join(root, 'full'), containerPath: '/work/full' },
      ],
    );
    expect(text).toContain('- empty at /work/empty. It has no source files.');
    expect(text).toContain('- full at /work/full. It has source files.');
  });

  it('lists each mounted directory and no other path', () => {
    const text = workingDirectoryBlock(
      ['api', 'web'],
      [
        { hostPath: '/tmp/api', containerPath: '/work/api' },
        { hostPath: '/tmp/web', containerPath: '/work/web' },
      ],
    );
    expect(text).toContain('- api at /work/api');
    expect(text).toContain('- web at /work/web');
    expect(text).toContain('nowhere else');
  });

  it('puts the working directory before the skill text', () => {
    const prompt = skillPrompt(
      'research',
      '{"prompt":"hello"}',
      ['run-example'],
      [],
      [{ hostPath: '/tmp/run-example', containerPath: '/work' }],
    );
    const pathAt = prompt.indexOf('The only working directory is /work (run-example).');
    const ruleAt = prompt.indexOf(
      'Do not start a service, a database, or the application. Do not run tests on this machine.',
    );
    const skillAt = prompt.indexOf('# Research');
    expect(pathAt).toBe(0);
    expect(ruleAt).toBeGreaterThan(pathAt);
    expect(skillAt).toBeGreaterThan(ruleAt);
  });

  it('puts English first on every agent prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-lang-'));
    const prompts: string[] = [];
    await new AgentLauncher(
      {
        run: async (input: AgentRunInput) => {
          prompts.push(input.prompt);
          return emptyAgent();
        },
      } as never,
      { tokenTotal: async () => 0 } as never,
      new RunStop(),
    ).launch({
      root,
      run: { agentCalls: 0, spentUsd: 0 } as never,
      key: 'k',
      step: 'plan',
      mode: 'plan',
      tools: 'write',
      runtime: 'cursor',
      model: 'm',
      timeLimitMs: 1,
      prompt: 'Зроби поле',
      workspace: root,
      mounts: [],
    });
    expect(prompts[0]).toBe(`${AGENT_LANGUAGE_RULE}\n${AGENT_FOREGROUND_RULE}\n\nЗроби поле`);
  });

  it('passes a continue prompt through without the English rule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-continue-'));
    const prompts: string[] = [];
    const continues: (string | null | undefined)[] = [];
    await new AgentLauncher(
      {
        run: async (input: AgentRunInput) => {
          prompts.push(input.prompt);
          continues.push(input.continuePrompt);
          return emptyAgent();
        },
      } as never,
      { tokenTotal: async () => 0 } as never,
      new RunStop(),
    ).launch({
      root,
      run: { agentCalls: 0, spentUsd: 0 } as never,
      key: 'k',
      step: 'plan',
      mode: 'plan',
      tools: 'write',
      runtime: 'cursor',
      model: 'm',
      timeLimitMs: 1,
      prompt: 'Зроби поле',
      continuePrompt: 'Finish the checklist.',
      workspace: root,
      mounts: [],
    });
    expect(prompts[0]).toBe(`${AGENT_LANGUAGE_RULE}\n${AGENT_FOREGROUND_RULE}\n\nЗроби поле`);
    expect(continues[0]).toBe('Finish the checklist.');
  });
});

describe('model visit duration', () => {
  it('keeps the step wall time when the agent itself was shorter', () => {
    const started = Date.now() - 4_000;
    const visit = modelVisit({
      now: Date.now(),
      opened: {
        run: { stepStartedAt: new Date(started).toISOString() } as never,
        attemptId: 'attempt-1',
        prior: null,
        previousStep: 'research',
        previousStatus: 'waiting',
        started,
        startedAt: new Date(started).toISOString(),
      },
      step: 'research',
      mode: 'agent',
      runtime: 'cursor',
      model: 'm',
      agent: { ...emptyAgent(), durationMs: 25 },
      prompt: 'p',
      status: 'done',
      exitCode: 0,
    });
    expect(visit.durationMs).toBeGreaterThanOrEqual(4_000);
    expect(visit.exchange?.durationMs).toBe(25);
  });
});

describe('combineAgentResults', () => {
  it('stores a resumed retry once when that output already includes the earlier launch', () => {
    const earlier = '{"type":"result","usage":{"inputTokens":10,"outputTokens":4}}\nprocess killed: time\n';
    const resumed = `process started\n${earlier}{"type":"result","usage":{"inputTokens":3,"outputTokens":1}}\nprocess exited 0\n`;
    const folded = combineAgentResults([
      { ...emptyAgent(), output: earlier, killReason: 'time', exitCode: 1, tokensIn: 10, tokensOut: 4, calls: 1 },
      {
        ...emptyAgent(),
        output: resumed,
        resumed: true,
        killReason: null,
        exitCode: 0,
        tokensIn: 3,
        tokensOut: 1,
        calls: 1,
        responseText: 'summary:\n- done\n',
      },
    ]);
    const visit = modelVisit({
      now: Date.now(),
      opened: {
        run: { stepStartedAt: new Date().toISOString() } as never,
        attemptId: 'attempt-1',
        prior: null,
        previousStep: 'research',
        previousStatus: 'waiting',
        started: Date.now(),
        startedAt: new Date().toISOString(),
      },
      step: 'research',
      mode: 'plan',
      runtime: 'cursor',
      model: 'm',
      agent: folded,
      prompt: 'p',
      status: 'done',
      exitCode: 0,
    });
    const log = folded?.output ?? '';
    expect(visit.documents?.map((document) => document.kind) ?? []).not.toContain('log');
    expect(log).toBe(`${resumed}`);
    expect(log.match(/process killed: time/g)).toHaveLength(1);
    expect(log.match(/"inputTokens":10/g)).toHaveLength(1);
    expect(folded?.tokensIn).toBe(13);
    expect(folded?.killReason).toBeNull();
  });

  it('joins launches that were not resumed', () => {
    const folded = combineAgentResults([
      { ...emptyAgent(), output: 'process killed: time\n', killReason: 'time', exitCode: 1 },
      { ...emptyAgent(), output: 'process exited 0\n' },
    ]);
    expect(folded?.output).toBe('process killed: time\n\nprocess exited 0\n');
  });

  it('keeps a fresh time kill when a later resume only has the truncated file', () => {
    const first = '{"type":"result","usage":{"inputTokens":10,"outputTokens":4}}\nprocess killed: time\n';
    const second = '{"type":"result","usage":{"inputTokens":5,"outputTokens":2}}\nprocess killed: time\n';
    const third = `process started\n${second}{"type":"result","usage":{"inputTokens":1,"outputTokens":1}}\nprocess exited 0\n`;
    const folded = combineAgentResults([
      { ...emptyAgent(), output: first, killReason: 'time', exitCode: 1, tokensIn: 10, tokensOut: 4, calls: 1 },
      { ...emptyAgent(), output: second, killReason: 'time', exitCode: 1, tokensIn: 5, tokensOut: 2, calls: 1 },
      {
        ...emptyAgent(),
        output: third,
        resumed: true,
        killReason: null,
        exitCode: 0,
        tokensIn: 1,
        tokensOut: 1,
        calls: 1,
      },
    ]);
    const log = folded?.output ?? '';
    expect(log.startsWith(first)).toBe(true);
    expect(log.match(/"inputTokens":10/g)).toHaveLength(1);
    expect(log.match(/"inputTokens":5/g)).toHaveLength(1);
    expect(log.match(/process killed: time/g)).toHaveLength(2);
  });

  it('keeps an earlier launch when a resumed run did not carry the file', () => {
    const earlier = '{"type":"result","usage":{"inputTokens":10,"outputTokens":4}}\nprocess killed: time\n';
    const alone = '{"type":"result","usage":{"inputTokens":2,"outputTokens":1}}\nprocess exited 0\n';
    const folded = combineAgentResults([
      { ...emptyAgent(), output: earlier, killReason: 'time', exitCode: 1 },
      { ...emptyAgent(), output: alone, resumed: true, exitCode: 0 },
    ]);
    expect(folded?.output).toBe(`${earlier}\n${alone}`);
    expect(folded?.output?.match(/"inputTokens":10/g)).toHaveLength(1);
  });

  it('stores one copy when a later resume already holds the earlier launches', () => {
    const first = '{"type":"result","usage":{"inputTokens":10,"outputTokens":4}}\nprocess killed: time\n';
    const secondBody = '{"type":"result","usage":{"inputTokens":5,"outputTokens":2}}\nprocess killed: time\n';
    const second = `process started\n${first}${secondBody}`;
    const third = `process started\n${first}process started\n${secondBody}{"type":"result","usage":{"inputTokens":1,"outputTokens":1}}\nprocess exited 0\n`;
    const folded = combineAgentResults([
      { ...emptyAgent(), output: first, killReason: 'time', exitCode: 1 },
      { ...emptyAgent(), output: second, resumed: true, killReason: 'time', exitCode: 1 },
      { ...emptyAgent(), output: third, resumed: true, exitCode: 0 },
    ]);
    expect(folded?.output).toBe(third);
    expect(folded?.output?.match(/"inputTokens":10/g)).toHaveLength(1);
    expect(folded?.output?.match(/"inputTokens":5/g)).toHaveLength(1);
  });
});

describe('agentFailure', () => {
  it('keeps a bare exit when the process wrote nothing', () => {
    expect(agentFailure({ ...emptyAgent(), exitCode: 1 }, 'code-review', 'agent')).toBe('code-review failed');
  });

  it('includes a short process error', () => {
    expect(
      agentFailure({ ...emptyAgent(), exitCode: 1, output: 'E2BIG: spawn docker E2BIG\n' }, 'code-review', 'agent'),
    ).toBe('code-review failed: E2BIG: spawn docker E2BIG');
  });

  it('drops a long stream', () => {
    expect(agentFailure({ ...emptyAgent(), exitCode: 1, output: 'x'.repeat(501) }, 'code-review', 'agent')).toBe(
      'code-review failed',
    );
  });

  it('fails a clean exit when a write was refused', () => {
    const output = [
      JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: 'Bash', message: 'needs approval' }),
      JSON.stringify({
        type: 'system',
        subtype: 'permission_denied',
        tool_name: 'Write',
        message:
          "Claude requested permissions to write to /work/swarmloop/nest/src/steps/step.ts, but you haven't granted it yet.",
      }),
    ].join('\n');
    expect(agentFailure({ ...emptyAgent(), exitCode: 0, output }, 'implement', 'agent')).toBe(
      "implement failed: Claude requested permissions to write to /work/swarmloop/nest/src/steps/step.ts, but you haven't granted it yet.",
    );
  });

  it('keeps a clean exit when only a shell command was refused', () => {
    const output = JSON.stringify({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      message: 'This Bash command contains multiple operations.',
    });
    expect(agentFailure({ ...emptyAgent(), exitCode: 0, output }, 'implement', 'agent')).toBeNull();
  });
});

describe('agent step without requirements', () => {
  it.each([
    ['absent', null],
    ['blank', ''],
  ])(
    'fails the visit with the model and mode of its profile, and no exchange when requirements are %s',
    async (_name, stored) => {
      const agent = jest.fn();
      const golden = await goldenApp('agent-missing-requirements', { agent });
      try {
        const run = await golden.runs.begin('PROJ-30', 'prepare');
        run.status = 'waiting';
        run.currentStep = 'research';
        await golden.runs.saveRun(run);
        if (stored !== null) {
          await golden.seedDocuments.putDocument(run, 'requirements', stored);
        }
        const step = new ResearchStep(
          new StepKernel(
            golden.runs,
            golden.documents,
            golden.visits,
            golden.flows,
            golden.clock,
            golden.config,
            golden.stepEvents,
          ),
          golden.sandbox,
          golden.launcher,
        );
        const result = await step.execute('PROJ-30');
        expect(result.message).toContain('requirements is missing');
        const [stat] = await golden.visits.listStats(run.id);
        expect(stat).toMatchObject({ step: 'research', status: 'failed', model: 'opus-5.5-extra-high', mode: 'plan' });
        expect(await golden.visits.listExchanges([stat.id])).toEqual([]);
        expect(agent).not.toHaveBeenCalled();
      } finally {
        await golden.close();
      }
    },
  );
});

describe('agent step failure', () => {
  it('gives the route message and the summary one error id, and logs that id once', async () => {
    const agent = jest.fn().mockRejectedValue(new Error('agent crashed'));
    const golden = await goldenApp('agent-plain-failure', { agent, worktrees: ['PROJ-31/billing-api'] });
    const logged = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const run = await golden.runs.begin('PROJ-31', 'prepare');
      run.status = 'waiting';
      run.currentStep = 'research';
      await golden.runs.saveRun(run);
      await golden.seedDocuments.putDocument(run, 'requirements', '{"prompt":"ship the field"}\n');
      const step = new ResearchStep(
        new StepKernel(
          golden.runs,
          golden.documents,
          golden.visits,
          golden.flows,
          golden.clock,
          golden.config,
          golden.stepEvents,
        ),
        golden.sandbox,
        golden.launcher,
      );
      const conclude = jest.spyOn(step as unknown as { conclude: () => Promise<unknown> }, 'conclude');
      const result = await step.execute('PROJ-31');
      const [, stepResult] = conclude.mock.calls[0] as unknown as [unknown, StepResult];
      const id = /\((E-[0-9a-z]{8})\)$/.exec(result.message)?.[1];
      expect(id).toMatch(/^E-[0-9a-z]{8}$/);
      expect(stepResult.route).toEqual({
        to: 'fail',
        error: {
          code: 'STEP_FAILED',
          category: 'internal',
          errorId: id,
          message: `research failed: agent crashed (${id})`,
        },
      });
      expect(stepResult.summary).toContain(`research failed: agent crashed (${id})`);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(String(logged.mock.calls[0][0])).toMatch(new RegExp(`^${id} `));
    } finally {
      logged.mockRestore();
      await golden.close();
    }
  });
});

describe('agent step during a passing outage', () => {
  async function waitingRun(
    thrown: Error,
  ): Promise<{ stateReason: string | null; status: string; stats: string[]; retryAt: string }> {
    const golden = await goldenApp('agent-outage', {
      agent: jest.fn().mockRejectedValue(thrown),
      worktrees: ['PROJ-32/billing-api'],
    });
    try {
      const run = await golden.runs.begin('PROJ-32', 'prepare');
      run.status = 'waiting';
      run.currentStep = 'research';
      await golden.runs.saveRun(run);
      await golden.seedDocuments.putDocument(run, 'requirements', '{"prompt":"ship the field"}\n');
      const kernel = new StepKernel(
        golden.runs,
        golden.documents,
        golden.visits,
        golden.flows,
        golden.clock,
        golden.config,
        golden.stepEvents,
      );
      const retryAt = new Date(golden.clock.now() + golden.config.env.RECONCILE_MS).toISOString();
      await new ResearchStep(kernel, golden.sandbox, golden.launcher).execute('PROJ-32');
      const stored = await golden.runs.findRun('PROJ-32');
      const stats = await golden.visits.listStats(run.id);
      return {
        stateReason: stored?.stateReason ?? null,
        status: stored?.status ?? '',
        stats: stats.map((item) => item.status),
        retryAt,
      };
    } finally {
      await golden.close();
    }
  }

  it('waits with the host message and its next try when a host stays down', async () => {
    const retryAt = '2026-11-12T15:00:00.000Z';
    const ended = await waitingRun(new HostUnavailable('api.github.com', 'HTTP 503', retryAt));
    expect(ended.status).toBe('waiting');
    expect(JSON.parse(ended.stateReason ?? '{}')).toEqual({
      code: 'HOST_UNAVAILABLE',
      message: `api.github.com did not answer: HTTP 503; next try at ${retryAt}`,
      retryAt,
    });
    expect(ended.stats).toEqual(['waiting']);
    expect(failedLaunches([{ id: 1, step: 'research', status: ended.stats[0] }], 'research', 0)).toBe(0);
  });

  it('waits with DOCKER_UNAVAILABLE when docker is down, one tick ahead', async () => {
    const ended = await waitingRun(
      new SwarmloopError('docker is not running', { code: ERROR_CODES.DOCKER_UNAVAILABLE }),
    );
    expect(ended.status).toBe('waiting');
    expect(JSON.parse(ended.stateReason ?? '{}')).toEqual({
      code: 'DOCKER_UNAVAILABLE',
      message: `docker did not answer; next try at ${ended.retryAt}`,
      retryAt: ended.retryAt,
    });
    expect(ended.stats).toEqual(['waiting']);
  });
});

function emptyAgent(): AgentRunResult {
  return {
    responseText: '',
    chatId: null,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    killReason: null,
    exitCode: 0,
    resumed: false,
    calls: 0,
    samples: [],
    durationMs: 0,
    startedAt: '',
    finishedAt: '',
  };
}
