import type { AgentRunResult } from '../../agent/agent-runner';
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

    it(`reads the first non-empty line of a short failed output in ${mode} mode`, () => {
      expect(agentFailure(agent({ exitCode: 2, output: '\n\n  first line  \nsecond\n' }), 'implement', mode)).toBe(
        'implement failed: first line',
      );
    });

    it(`gives no detail when a failed output is empty or over 500 characters in ${mode} mode`, () => {
      expect(agentFailure(agent({ exitCode: 2, output: '' }), 'implement', mode)).toBe('implement failed');
      expect(agentFailure(agent({ exitCode: 2, output: `boom\n${'x'.repeat(500)}` }), 'implement', mode)).toBe(
        'implement failed',
      );
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

  it('names a refusal with an empty message', () => {
    expect(refusedWrite(refused('Write', '   '))).toBe('write permission denied');
  });

  it('cuts a message over 180 characters at 180', () => {
    expect(refusedWrite(refused('Write', 'x'.repeat(300)))).toBe('x'.repeat(180));
  });

  it('skips a line that holds permission_denied text but is not JSON', () => {
    expect(refusedWrite('{ "subtype": "permission_denied" and a broken line')).toBeNull();
  });

  it('ignores permission_denied text inside another event subtype', () => {
    const other = JSON.stringify({
      type: 'system',
      subtype: 'tool_result',
      tool_name: 'Write',
      message: 'permission_denied',
    });
    expect(refusedWrite(other)).toBeNull();
  });

  it('skips a malformed line between two refusals and keeps the last valid one', () => {
    const broken = '{"subtype":"permission_denied", broken';
    expect(refusedWrite([refused('Write', 'first'), broken, refused('Edit', 'second')].join('\n'))).toBe('second');
    expect(refusedWrite([refused('Write', 'first'), broken].join('\n'))).toBe('first');
  });
});

describe('withRefusal', () => {
  it('adds the refused write only when there is one', () => {
    expect(withRefusal('plan is missing', null)).toBe('plan is missing');
    expect(withRefusal('plan is missing', WRITE_REFUSED)).toBe(
      `plan is missing; a write was refused: ${WRITE_REFUSED}`,
    );
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
