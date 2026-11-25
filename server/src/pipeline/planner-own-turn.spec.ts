import type { Clock } from '../core/clock';
import type { PlanChatEntry } from '../contract/plan-chat';
import type { RunEntity } from '../history/entities';
import type { PlanChatStore } from '../history/plan-chat.store';
import type { RunRepository } from '../history/run.repository';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import type { CommandService } from './command.service';
import { PlannerOwnTurn } from './planner-own-turn';
import { PlannerTurns } from './planner-turns';
import type { StartGate } from './start-gate';

const AT = '2026-01-01T00:00:00.000Z';

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
      for (const entry of entries) if (keys.includes(entry.key)) entry.state = 'taken';
    },
  };
}

function setup(options: {
  messages?: PlanChatEntry[];
  reply?: unknown;
  visit?: 'none' | 'refused';
  stopped?: boolean;
  submit?: () => Promise<unknown>;
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
  const visit = jest.fn(async () =>
    options.visit === 'none'
      ? null
      : options.visit === 'refused'
        ? { refused: new Error('door says no') }
        : { value: options.reply ?? { reply: 'Done.' } },
  );
  const run = { key: 'run-1', status: 'waiting', stateReason: null } as unknown as RunEntity;
  const clock = { iso: () => AT, now: () => new Date(AT) } as unknown as Clock;
  const own = new PlannerOwnTurn(
    turns,
    { visit } as unknown as PlanConversation,
    chat as unknown as PlanChatStore,
    { findRun: async () => run } as unknown as RunRepository,
    { submit } as unknown as CommandService,
    clock,
    { stopped: async () => options.stopped ?? false } as unknown as StartGate,
  );
  return { own, chat, turns, visit, submit, escalated, free };
}

describe('PlannerOwnTurn', () => {
  it('ends with no visit when no message waits', async () => {
    const { own, visit, submit } = setup({ messages: [] });
    await own.take('run-1');
    expect(visit).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  });

  it('takes the messages and writes the reply when it only answers, and starts a session the run has none of', async () => {
    const { own, chat, visit, submit } = setup({ messages: [message('message-1', 'a'), message('message-2', 'b')] });
    await own.take('run-1');
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
    await own.take('run-1');
    expect(chat.entries.at(-1)?.text).toBe('Done.\n\nThe run stays stopped. Resume starts it.');
  });

  it('resumes as the person after its turn ended, and leaves the messages pending for the resumed run', async () => {
    const { own, chat, submit, free } = setup({ reply: { reply: 'Going on.', resume: true } });
    await own.take('run-1');
    expect(submit).toHaveBeenCalledWith('resume', 'run-1', { by: 'person' }, { idempotencyKey: 'resume-message-1' });
    expect(free).toEqual([true]);
    expect(chat.entries[0].state).toBe('pending');
    expect(chat.entries[1]).toMatchObject({ key: `reply-${AT}`, text: 'Going on.' });
  });

  it('replays from the step with its instruction as the prompt, and takes the messages', async () => {
    const { own, chat, submit, free } = setup({
      reply: { reply: 'Again.', replay: { step: 'implement', instruction: 'Fix the flag.' } },
    });
    await own.take('run-1');
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
    await own.take('run-1');
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

  it('writes a refused command as one line that says why, and takes the messages', async () => {
    const { own, chat } = setup({
      reply: { reply: 'Going on.', resume: true },
      submit: () => Promise.reject(new Error('run-1 is already running')),
    });
    await own.take('run-1');
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
      await own.take('run-1');
      expect(chat.entries).toEqual([expect.objectContaining({ key: 'message-1', state: 'taken' })]);
      expect(submit).not.toHaveBeenCalled();
    }
  });

  it('takes messages recorded in a row once: the second take finds none pending', async () => {
    const { own, visit } = setup({});
    await Promise.all([own.take('run-1'), own.take('run-1')]);
    expect(visit).toHaveBeenCalledTimes(1);
  });
});
