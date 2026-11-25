import type { Clock } from '../core/clock';
import type { PlanChatEntry, PlanChatWait } from '../contract/plan-chat';
import type { AgentRunResult } from '../agent/agent-result';
import { ModelHostUnavailable } from '../steps/shared/model-host-unavailable';
import type { RunEntity } from '../history/entities';
import type { PlanChatStore } from '../history/plan-chat.store';
import type { RunRepository } from '../history/run.repository';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import type { CommandService } from './command.service';
import { PlannerOwnTurn } from './planner-own-turn';
import { PlannerTurns } from './planner-turns';
import { asksForStarter } from '../steps/shared/starter-asks';
import type { StartGate } from './start-gate';

const AT = '2026-01-01T00:00:00.000Z';

/** No driver holds the run. */
const idle = async (): Promise<boolean> => false;

const message = (key: string, text: string): PlanChatEntry => ({
  key,
  role: 'person',
  text,
  at: AT,
  state: 'pending',
});

/** The run's chat as a list: the same pending, append and take the store has. */
function fakeChat(entries: PlanChatEntry[]) {
  return {
    entries,
    pending: async () => entries.filter((entry) => entry.role === 'person' && entry.state === 'pending'),
    appendEntry: async (_key: string, entry: PlanChatEntry) => {
      entries.push(entry);
    },
    markTaken: async (_key: string, keys: readonly string[]) => {
      for (const entry of entries) {
        if (!keys.includes(entry.key)) continue;
        entry.state = 'taken';
        delete entry.wait;
      }
    },
    wait: async (_key: string, keys: readonly string[], wait: PlanChatWait | null) => {
      for (const entry of entries) {
        if (entry.state !== 'pending' || !keys.includes(entry.key)) continue;
        if (wait) entry.wait = { ...wait, since: entry.wait?.since ?? wait.since };
        else delete entry.wait;
      }
    },
  };
}

/** The host did not answer; its next try is a fixed time. */
const outage = (): ModelHostUnavailable =>
  new ModelHostUnavailable({ host: 'the model host', detail: 'HTTP 503' }, {
    finishedAt: AT,
  } as unknown as AgentRunResult);

function setup(options: {
  messages?: PlanChatEntry[];
  reply?: unknown;
  visit?: 'none' | 'refused' | 'outage';
  stopped?: boolean;
  submit?: () => Promise<unknown>;
  run?: Partial<RunEntity>;
}) {
  const chat = fakeChat(options.messages ?? [message('message-1', 'please go on')]);
  const turns = new PlannerTurns();
  const escalated = jest.spyOn(turns, 'escalate').mockResolvedValue();
  const free: boolean[] = [];
  const submit = jest.fn(async () => {
    // The command goes after the turn ended: a turn of the run can begin now.
    turns.offer('run-1', { id: 'next', at: AT, text: '' });
    free.push(turns.begin('run-1') !== null);
    turns.end('run-1');
    return options.submit ? options.submit() : {};
  });
  const visit = jest.fn(async () => {
    if (options.visit === 'outage') throw outage();
    return options.visit === 'none'
      ? null
      : options.visit === 'refused'
        ? { refused: new Error('door says no') }
        : { value: options.reply ?? { reply: 'Done.' } };
  });
  const run = { key: 'run-1', status: 'waiting', stateReason: null, ...options.run } as unknown as RunEntity;
  const release = jest.fn(async () => run);
  const clock = { iso: () => AT, now: () => new Date(AT) } as unknown as Clock;
  const own = new PlannerOwnTurn(
    turns,
    { visit } as unknown as PlanConversation,
    chat as unknown as PlanChatStore,
    { findRun: async () => run, release } as unknown as RunRepository,
    { submit } as unknown as CommandService,
    clock,
    { stopped: async () => options.stopped ?? false } as unknown as StartGate,
  );
  return { own, chat, turns, visit, submit, escalated, free, release, options };
}

describe('PlannerOwnTurn', () => {
  it('ends with no visit when no message waits', async () => {
    const { own, visit, submit } = setup({ messages: [] });
    await own.take('run-1', idle);
    expect(visit).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('takes the messages and writes the reply when it only answers, and starts a session the run has none of', async () => {
    const { own, chat, visit, submit } = setup({ messages: [message('message-1', 'a'), message('message-2', 'b')] });
    await own.take('run-1', idle);
    expect(chat.entries.map((entry) => [entry.key, entry.state])).toEqual([
      ['message-1', 'taken'],
      ['message-2', 'taken'],
      [`reply-${AT}`, 'taken'],
    ]);
    expect(chat.entries[2]).toMatchObject({ role: 'planner', text: 'Done.' });
    expect(submit).not.toHaveBeenCalled();
    const args = visit.mock.calls[0] as unknown[];
    expect(args[4]).toEqual(['a', 'b']);
    expect(args.slice(5)).toEqual([{ by: 'person' }, true]);
  });

  it('says in the reply that a stopped run stays stopped', async () => {
    const { own, chat } = setup({ stopped: true });
    await own.take('run-1', idle);
    expect(chat.entries.at(-1)?.text).toBe('Done.\n\nThe run stays stopped. Resume starts it.');
  });

  it('resumes as the person after its turn ended, and leaves the messages pending for the resumed run', async () => {
    const { own, chat, submit, free } = setup({ reply: { reply: 'Going on.', resume: true } });
    await own.take('run-1', idle);
    expect(submit).toHaveBeenCalledWith('resume', 'run-1', { by: 'person' }, { idempotencyKey: 'resume-message-1' });
    expect(free).toEqual([true]);
    expect(chat.entries[0].state).toBe('pending');
    expect(chat.entries[1]).toMatchObject({ key: `reply-${AT}`, text: 'Going on.' });
  });

  it('replays from the step with its instruction as the prompt, and takes the messages', async () => {
    const { own, chat, submit, free } = setup({
      reply: { reply: 'Again.', replay: { step: 'implement', instruction: 'Fix the flag.' } },
    });
    await own.take('run-1', idle);
    expect(submit).toHaveBeenCalledWith(
      'replay',
      'run-1',
      { step: 'implement', prompt: 'Fix the flag.', by: 'person' },
      { idempotencyKey: 'replay-message-1' },
    );
    expect(free).toEqual([true]);
    expect(chat.entries[0].state).toBe('taken');
  });

  it('escalates what the planner cannot settle, writes it as pending for the person and sends no command', async () => {
    const { own, chat, escalated, submit } = setup({ reply: { reply: 'Not mine.', escalate: 'Which database?' } });
    await own.take('run-1', idle);
    const escalation = chat.entries.find((entry) => entry.kind === 'escalation');
    expect(escalation).toMatchObject({
      key: 'escalate-message-1',
      role: 'planner',
      state: 'pending',
      text: 'Which database?',
    });
    expect(escalated).toHaveBeenCalledWith(expect.objectContaining({ key: 'run-1' }), escalation);
    expect(chat.entries[0].state).toBe('taken');
    expect(submit).not.toHaveBeenCalled();
  });

  it("hands a subtask's escalation up as its implement's hand-up, which its parent's planner finds", async () => {
    const { own, chat, escalated } = setup({
      reply: { reply: 'Not mine.', escalate: 'Which database?' },
      run: { parentRunId: 4 },
    });
    await own.take('run-1', idle);
    expect(asksForStarter({ entries: chat.entries })).toMatchObject([
      { key: 'handback-implement-message-1-0', text: 'Which database?', from: 'implement' },
    ]);
    expect(chat.entries[0].state).toBe('taken');
    expect(escalated).not.toHaveBeenCalled();
  });

  it('writes a refused command as one line that says why, and takes the messages', async () => {
    const { own, chat } = setup({
      reply: { reply: 'Going on.', resume: true },
      submit: () => Promise.reject(new Error('run-1 is already running')),
    });
    await own.take('run-1', idle);
    expect(chat.entries[0].state).toBe('taken');
    expect(chat.entries.at(-1)).toMatchObject({
      key: 'refused-resume-message-1',
      role: 'planner',
      state: 'taken',
      text: 'The resume was refused: run-1 is already running',
    });
  });

  it('takes the messages when the planner gives no usable reply or its start is refused', async () => {
    for (const visit of ['none', 'refused'] as const) {
      const { own, chat, submit } = setup({ visit });
      await own.take('run-1', idle);
      expect(chat.entries).toEqual([expect.objectContaining({ key: 'message-1', state: 'taken' })]);
      expect(submit).not.toHaveBeenCalled();
    }
  });

  it('takes messages recorded in a row once: the second take finds none pending', async () => {
    const { own, visit } = setup({});
    await Promise.all([own.take('run-1', idle), own.take('run-1', idle)]);
    expect(visit).toHaveBeenCalledTimes(1);
  });

  it('leaves the messages a resume handed over to the resumed run when a second take waited behind it', async () => {
    let started = false;
    const { own, chat, visit } = setup({
      reply: { reply: 'Going on.', resume: true },
      submit: async () => {
        started = true;
        return {};
      },
    });
    const busy = async (): Promise<boolean> => started;
    await Promise.all([own.take('run-1', busy), own.take('run-1', busy)]);
    expect(visit).toHaveBeenCalledTimes(1);
    expect(chat.entries[0].state).toBe('pending');
  });

  describe('when the model host does not answer', () => {
    const retryAt = (): string => outage().retryAt;
    const waiting = (since: string, at: string): PlanChatWait => ({
      on: 'model-host',
      since,
      message: 'the model host did not answer: HTTP 503',
      retryAt: at,
    });

    it('keeps a stopped run stopped: the wait is stored, the messages stay pending, no line is written', async () => {
      const { own, chat, release, submit } = setup({ visit: 'outage', stopped: true });
      await own.take('run-1', idle);
      expect(chat.entries).toEqual([
        expect.objectContaining({ key: 'message-1', state: 'pending', wait: waiting(AT, retryAt()) }),
      ]);
      expect(release).not.toHaveBeenCalled();
      expect(submit).not.toHaveBeenCalled();
    });

    it("stores the host's words only, with no time in them", async () => {
      const { own, chat } = setup({ visit: 'outage', stopped: true });
      await own.take('run-1', idle);
      expect(chat.entries[0].wait?.message).toBe('the model host did not answer: HTTP 503');
    });

    it('clears the wait when the reply fails with another error', async () => {
      const first = { ...message('message-1', 'a'), wait: waiting(AT, retryAt()) };
      const { own, chat, visit } = setup({ messages: [first] });
      visit.mockRejectedValueOnce(new Error('boom'));
      await expect(own.take('run-1', idle)).rejects.toThrow('boom');
      expect(chat.entries[0].wait).toBeUndefined();
    });

    it('ends a run that is not stopped in the host wait with the next try, the messages pending', async () => {
      const { own, chat, release } = setup({ visit: 'outage' });
      await own.take('run-1', idle);
      expect(release).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: 'waiting',
          reason: { code: 'HOST_UNAVAILABLE', message: outage().message, retryAt: retryAt() },
        }),
      );
      expect(chat.entries).toEqual([expect.objectContaining({ key: 'message-1', state: 'pending' })]);
      expect(chat.entries[0].wait).toBeUndefined();
    });

    it('replaces the next try of a later outage and keeps since', async () => {
      const first = {
        ...message('message-1', 'a'),
        wait: waiting('2025-12-31T00:00:00.000Z', '2025-12-31T00:05:00.000Z'),
      };
      const { own, chat } = setup({ visit: 'outage', stopped: true, messages: [first] });
      await own.take('run-1', idle);
      expect(chat.entries[0].wait).toEqual(waiting('2025-12-31T00:00:00.000Z', retryAt()));
    });

    it('clears the wait when an answer-only reply takes the messages', async () => {
      const first = { ...message('message-1', 'a'), wait: waiting(AT, retryAt()) };
      const { own, chat } = setup({ messages: [first] });
      await own.take('run-1', idle);
      expect(chat.entries[0]).toMatchObject({ state: 'taken' });
      expect(chat.entries[0].wait).toBeUndefined();
    });

    it('clears the wait of the messages a resume reply leaves pending', async () => {
      const first = { ...message('message-1', 'a'), wait: waiting(AT, retryAt()) };
      const { own, chat } = setup({ messages: [first], reply: { reply: 'Going on.', resume: true } });
      await own.take('run-1', idle);
      expect(chat.entries[0].state).toBe('pending');
      expect(chat.entries[0].wait).toBeUndefined();
    });

    it('returns at once for a take whose outage key is in flight', async () => {
      const first = { ...message('message-1', 'a'), wait: waiting(AT, retryAt()) };
      const { own, visit } = setup({ messages: [first] });
      const key = `host-message-1-${retryAt()}`;
      await Promise.all([own.take('run-1', idle, key), own.take('run-1', idle, key)]);
      expect(visit).toHaveBeenCalledTimes(1);
    });

    it('does nothing when the stored wait no longer names the outage', async () => {
      const first = { ...message('message-1', 'a'), wait: waiting(AT, retryAt()) };
      const { own, visit, chat } = setup({ messages: [first] });
      await own.take('run-1', idle, 'host-message-1-2020-01-01T00:00:00.000Z');
      expect(visit).not.toHaveBeenCalled();
      expect(chat.entries[0].state).toBe('pending');
    });
  });
});
