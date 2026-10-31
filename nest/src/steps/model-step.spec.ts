import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentRunInput, AgentRunResult } from '../limits/agent-runner';
import { AGENT_LANGUAGE_RULE, agentFailure, combineAgentResults, launchAgent, skillPrompt, workingDirectoryBlock } from './model-step';
import { modelVisit } from './model-visit';

describe('working directory block', () => {
  it('names the single scratch directory mounted at /work', () => {
    const text = workingDirectoryBlock(['run-example'], [{ hostPath: '/tmp/run-example-missing', containerPath: '/work' }]);
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
    const prompt = skillPrompt('research', '{"prompt":"hello"}', ['run-example'], [], [{ hostPath: '/tmp/run-example', containerPath: '/work' }]);
    const pathAt = prompt.indexOf('The only working directory is /work (run-example).');
    const ruleAt = prompt.indexOf('Do not start a service, a database, or the application. Do not run tests on this machine.');
    const skillAt = prompt.indexOf('# Research');
    expect(pathAt).toBe(0);
    expect(ruleAt).toBeGreaterThan(pathAt);
    expect(skillAt).toBeGreaterThan(ruleAt);
  });

  it('puts English first on every agent prompt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-lang-'));
    const prompts: string[] = [];
    await launchAgent({
      agent: {
        run: async (input: AgentRunInput) => {
          prompts.push(input.prompt);
          return emptyAgent();
        },
      } as never,
      history: { root: () => root, tokenTotal: async () => 0 } as never,
      run: { agentCalls: 0, spentUsd: 0 } as never,
      key: 'k',
      step: 'plan',
      mode: 'plan',
      model: 'm',
      timeLimitMs: 1,
      prompt: 'Зроби поле',
      workspace: root,
      mounts: [],
    });
    expect(prompts[0]).toBe(`${AGENT_LANGUAGE_RULE}\n\nЗроби поле`);
  });

  it('passes a continue prompt through without the English rule', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-continue-'));
    const prompts: string[] = [];
    const continues: (string | null | undefined)[] = [];
    await launchAgent({
      agent: {
        run: async (input: AgentRunInput) => {
          prompts.push(input.prompt);
          continues.push(input.continuePrompt);
          return emptyAgent();
        },
      } as never,
      history: { root: () => root, tokenTotal: async () => 0 } as never,
      run: { agentCalls: 0, spentUsd: 0 } as never,
      key: 'k',
      step: 'plan',
      mode: 'plan',
      model: 'm',
      timeLimitMs: 1,
      prompt: 'Зроби поле',
      continuePrompt: 'Finish the checklist.',
      workspace: root,
      mounts: [],
    });
    expect(prompts[0]).toBe(`${AGENT_LANGUAGE_RULE}\n\nЗроби поле`);
    expect(continues[0]).toBe('Finish the checklist.');
  });
});

describe('model visit duration', () => {
  it('keeps the step wall time when the agent itself was shorter', () => {
    const started = Date.now() - 4_000;
    const visit = modelVisit({
      opened: {
        run: { stepStartedAt: new Date(started).toISOString() } as never,
        prior: null,
        previousStep: 'research',
        previousStatus: 'waiting',
        started,
        startedAt: new Date(started).toISOString(),
      },
      step: 'research',
      mode: 'agent',
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
      opened: {
        run: { stepStartedAt: new Date().toISOString() } as never,
        prior: null,
        previousStep: 'research',
        previousStatus: 'waiting',
        started: Date.now(),
        startedAt: new Date().toISOString(),
      },
      step: 'research',
      mode: 'plan',
      model: 'm',
      agent: folded,
      prompt: 'p',
      status: 'done',
      exitCode: 0,
    });
    const log = visit.documents?.find((document) => document.kind === 'log')?.body ?? '';
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
      { ...emptyAgent(), output: third, resumed: true, killReason: null, exitCode: 0, tokensIn: 1, tokensOut: 1, calls: 1 },
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
    expect(agentFailure({ ...emptyAgent(), exitCode: 1 }, 'code-review')).toBe('code-review failed');
  });

  it('includes a short process error', () => {
    expect(agentFailure({ ...emptyAgent(), exitCode: 1, output: 'E2BIG: spawn docker E2BIG\n' }, 'code-review')).toBe(
      'code-review failed: E2BIG: spawn docker E2BIG',
    );
  });

  it('drops a long stream', () => {
    expect(agentFailure({ ...emptyAgent(), exitCode: 1, output: 'x'.repeat(501) }, 'code-review')).toBe('code-review failed');
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
