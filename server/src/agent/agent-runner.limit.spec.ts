import type { PersonalCredentials } from '../auth/personal-credentials.service';
import type { UserSettingRepository } from '../history/user-setting.repository';
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

  it('relaunches a kill by the memory cap up to MAX_LAUNCHES, because it is an out-of-memory failure and no stop from outside', async () => {
    const killed = { chunks: [], code: 137, memoryCapBytes: 1 << 30 };
    const { result, launches } = await start(
      'memory-cap',
      [killed, killed, killed],
      { resumeChatId: null, runtime: 'claude' },
      { MAX_LAUNCHES: 3 },
    );
    expect(result.signal).toBeUndefined();
    expect(launches).toHaveLength(3);
  });

  it('returns exit 137 of a container with no memory cap as a kill from outside', async () => {
    const { result, launches } = await start(
      'no-cap',
      [{ chunks: [], code: 137 }],
      { resumeChatId: null, runtime: 'claude' },
      { MAX_LAUNCHES: 3 },
    );
    expect(result.signal).toBe('SIGKILL');
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

  describe('paid use past the plan', () => {
    /** One launch of Claude as ada: its stream, whether it goes on running after it, and what ada stored. */
    function launchAs(stream: string[], paysPastLimit: boolean | undefined) {
      const credentials = {
        runtimeCredential: jest.fn().mockResolvedValue({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'tok', owner: 'ada' }),
      } as unknown as PersonalCredentials;
      const settings = {
        read: jest.fn().mockResolvedValue(paysPastLimit === undefined ? null : { paysPastLimit }),
      } as unknown as UserSettingRepository;
      return start(
        'paid-use',
        [{ chunks: [`${stream.join('\n')}\n`], running: true }],
        { resumeChatId: null, runtime: 'claude', login: 'ada' },
        { MAX_LAUNCHES: 3 },
        undefined,
        { credentials, settings },
      );
    }
    const event = (isUsingOverage: boolean): string =>
      JSON.stringify({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', resetsAt: 1795886400, rateLimitType: 'five_hour', isUsingOverage },
      });
    const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'chat-p1' });
    const done = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      session_id: 'chat-p1',
    });

    it('ends the launch at once on a line that says it runs on paid use, and returns the limit', async () => {
      const { result, launches } = await launchAs([init, event(true)], undefined);
      expect(result.killReason).toBe('paid use');
      expect(result.limit).toEqual({ window: '5-hour', resetsAt: '2026-11-28T17:20:00.000Z' });
      expect(launches).toHaveLength(1);
    });

    it('runs to its result when the person allowed paid use', async () => {
      const { result } = await launchAs([init, event(true), done], true);
      expect(result.limit).toBeUndefined();
      expect(result.killReason).toBeNull();
      expect(result.responseText).toBe('done');
    });

    it('runs to its result when the line says the plan still covers it', async () => {
      const { result } = await launchAs([init, event(false), done], undefined);
      expect(result.limit).toBeUndefined();
      expect(result.killReason).toBeNull();
    });
  });
});
