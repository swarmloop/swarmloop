import { AgentRunResult } from '../../agent/agent-runner';
import { agentFailure, refusedWrite, withRefusal } from './agent-result';

const WRITE_REFUSED = 'Cannot write to /work/x/a.php while in plan mode.';

describe('agentFailure', () => {
  const cases: [mode: string, tool: string, expected: string | null][] = [
    ['plan', 'Write', null],
    ['plan', 'Edit', null],
    ['ask', 'Write', null],
    ['ask', 'Edit', null],
    ['agent', 'Write', `implement failed: ${WRITE_REFUSED}`],
    ['agent', 'Edit', `implement failed: ${WRITE_REFUSED}`],
  ];
  for (const [mode, tool, expected] of cases) {
    it(`handles a refused ${tool} in ${mode} mode`, () => {
      expect(agentFailure(agent({ output: refused(tool) }), 'implement', mode)).toBe(expected);
    });
  }

  for (const mode of ['plan', 'ask', 'agent']) {
    it(`fails on a kill in ${mode} mode`, () => {
      expect(agentFailure(agent({ killReason: 'time' }), 'implement', mode)).toBe('process killed: time');
    });

    it(`fails on a bad exit in ${mode} mode`, () => {
      expect(agentFailure(agent({ exitCode: 1, output: 'boom\n' }), 'implement', mode)).toBe('implement failed: boom');
    });

    it(`ignores a refused non-write tool in ${mode} mode`, () => {
      expect(agentFailure(agent({ output: refused('Bash') }), 'implement', mode)).toBeNull();
    });
  }
});

describe('refusedWrite', () => {
  it('returns the last refused write', () => {
    expect(refusedWrite([refused('Write', 'first'), refused('Edit', 'second')].join('\n'))).toBe('second');
  });

  it('returns null when nothing was refused', () => {
    expect(refusedWrite('{"type":"result"}\n')).toBeNull();
    expect(refusedWrite(undefined)).toBeNull();
  });
});

describe('withRefusal', () => {
  it('adds the refused write only when there is one', () => {
    expect(withRefusal('plan is missing', null)).toBe('plan is missing');
    expect(withRefusal('plan is missing', WRITE_REFUSED)).toBe(`plan is missing; a write was refused: ${WRITE_REFUSED}`);
  });
});

function refused(tool: string, message = WRITE_REFUSED): string {
  return JSON.stringify({ type: 'system', subtype: 'permission_denied', tool_name: tool, message });
}

function agent(overrides: Partial<AgentRunResult>): AgentRunResult {
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
    ...overrides,
  };
}
