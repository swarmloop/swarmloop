import { start } from './agent-runner.spec-helpers';

/** What each runtime's CLI ends a launch with when the provider's limit is reached, with the reset it names. */
const LIMIT_SAMPLES = [
  {
    runtime: 'claude',
    // The reviewer output of run-mw85iykj: the text is the answer, so no step finds a decision in it.
    stream: [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'chat-r03' }),
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: "You've hit your 5-hour limit · resets 9:50pm (UTC)" }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: true,
        result: "You've hit your 5-hour limit · resets 9:50pm (UTC)",
        session_id: 'chat-r03',
      }),
    ].join('\n'),
    limit: { window: '5-hour', resetsAt: '2026-11-08T21:50:00.000Z' },
  },
  {
    runtime: 'codex',
    stream: `${JSON.stringify({ type: 'turn.failed', error: { message: "You've hit your usage limit. Upgrade to Plus to continue using Codex, or try again at 9:50 PM." } })}\n`,
    limit: { window: 'usage', resetsAt: '2026-11-08T21:50:00.000Z' },
  },
  {
    runtime: 'cursor',
    stream: `${JSON.stringify({ type: 'result', is_error: true, result: "You've hit your usage limit" })}\n`,
    limit: { window: 'usage' },
  },
] as const;

describe('AgentProcessRunner provider limit', () => {
  const NOW = Date.parse('2026-11-08T18:42:00Z');

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each(LIMIT_SAMPLES)(
    'returns the $runtime limit with its reset and launches once, because a limit is no attempt',
    async ({ runtime, stream, limit }) => {
      const { result, launches } = await start(
        `limit-${runtime}`,
        [{ chunks: [stream], code: 1 }],
        { resumeChatId: null, runtime },
        { MAX_LAUNCHES: 3, CODEX_API_KEY: 'codex-key' },
      );
      expect(result.limit).toEqual(limit);
      expect(launches).toHaveLength(1);
    },
  );

  it('does not take an auth error or a full context for a limit', async () => {
    for (const text of ['Invalid API key · Please run /login', 'Prompt is too long']) {
      const { result } = await start(
        'not-a-limit',
        [{ chunks: [`${JSON.stringify({ type: 'result', is_error: true, result: text })}\n`], code: 1 }],
        { resumeChatId: null, runtime: 'claude' },
        { MAX_LAUNCHES: 1 },
      );
      expect(result.limit).toBeUndefined();
    }
  });

  it('returns the model host outage and launches once, because the CLI already retried', async () => {
    const stream = `${JSON.stringify({ type: 'result', is_error: true, terminal_reason: 'api_error', result: 'API Error: 502 ENOTFOUND api.anthropic.com' })}\n`;
    const { result, launches } = await start(
      'outage',
      [{ chunks: [stream], code: 1 }],
      { resumeChatId: null, runtime: 'claude' },
      { MAX_LAUNCHES: 3 },
    );
    expect(result.outage).toEqual({ host: 'api.anthropic.com', detail: 'API Error: 502 ENOTFOUND api.anthropic.com' });
    expect(result.limit).toBeUndefined();
    expect(launches).toHaveLength(1);
  });

  it('returns a signal end and launches once, because a stopped container is no attempt to repeat', async () => {
    const { result, launches } = await start(
      'signal',
      [{ chunks: [], code: 143 }],
      { resumeChatId: null, runtime: 'claude' },
      { MAX_LAUNCHES: 3 },
    );
    expect(result).toMatchObject({ exitCode: 143, signal: 'SIGTERM', killReason: null });
    expect(launches).toHaveLength(1);
  });

  it('relaunches a crash by another signal, which is no stop from outside', async () => {
    const { result, launches } = await start(
      'crash',
      [
        { chunks: [], code: 139 },
        { chunks: [], code: 139 },
        { chunks: [], code: 139 },
      ],
      { resumeChatId: null, runtime: 'claude' },
      { MAX_LAUNCHES: 3 },
    );
    expect(result.signal).toBe('SIGSEGV');
    expect(launches.length).toBeGreaterThan(1);
  });
});
