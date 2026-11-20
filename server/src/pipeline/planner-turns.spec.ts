import type { RunEntity } from '../history/entities';
import type { PipelineResult } from '../core/pipeline-result';
import type { DocumentRepository } from '../history/document.repository';
import type { PlanChatEntry } from '../contract/plan-chat';
import type { PlanChatStore } from '../history/plan-chat.store';
import type { RunRepository } from '../history/run.repository';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import { asksForStarter } from '../steps/shared/starter-asks';
import { PlannerTurns, type PlannerTurn } from './planner-turns';

const turn = (id: string, at: string): PlannerTurn => ({ id, at, text: `text of ${id}` });

describe('PlannerTurns', () => {
  it('starts one turn at a time per run and the next one only after the first ends', () => {
    const turns = new PlannerTurns();
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    turns.offer('run-1', turn('b', '2026-01-01T00:00:01.000Z'));
    expect(turns.begin('run-1')?.id).toBe('a');
    expect(turns.replying('run-1')).toBe(true);
    expect(turns.begin('run-1')).toBeNull();
    turns.end('run-1');
    expect(turns.replying('run-1')).toBe(false);
    expect(turns.begin('run-1')?.id).toBe('b');
  });

  it('orders the turns of a run by the time of their entries, not by when they were offered', () => {
    const turns = new PlannerTurns();
    turns.offer('run-1', turn('late', '2026-01-01T00:00:05.000Z'));
    turns.offer('run-1', turn('early', '2026-01-01T00:00:01.000Z'));
    turns.offer('run-1', turn('same-as-late', '2026-01-01T00:00:05.000Z'));
    expect(turns.pending('run-1').map((held) => held.id)).toEqual(['early', 'late', 'same-as-late']);
  });

  it('holds a turn that is offered again once, also while it runs', () => {
    const turns = new PlannerTurns();
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    expect(turns.pending('run-1')).toHaveLength(1);
    turns.begin('run-1');
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    expect(turns.pending('run-1')).toEqual([]);
  });

  it('runs a turn started through exclusive only after the turn that runs, in the order they asked', async () => {
    const turns = new PlannerTurns();
    const order: string[] = [];
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    turns.begin('run-1');
    const first = turns.exclusive('run-1', turn('b', '2026-01-01T00:00:01.000Z'), () => {
      order.push('b');
      return Promise.resolve('first');
    });
    const second = turns.exclusive('run-1', turn('c', '2026-01-01T00:00:02.000Z'), () => {
      order.push('c');
      return Promise.resolve('second');
    });
    const other = await turns.exclusive('run-2', turn('d', '2026-01-01T00:00:00.000Z'), () => Promise.resolve('free'));
    expect(other).toBe('free');
    expect(order).toEqual([]);
    expect(turns.replying('run-1')).toBe(true);

    turns.end('run-1');

    expect([await first, await second]).toEqual(['first', 'second']);
    expect(order).toEqual(['b', 'c']);
    expect(turns.replying('run-1')).toBe(false);
  });

  it('keeps the runs apart', () => {
    const turns = new PlannerTurns();
    turns.offer('run-1', turn('a', '2026-01-01T00:00:00.000Z'));
    turns.offer('run-2', turn('b', '2026-01-01T00:00:00.000Z'));
    expect(turns.begin('run-1')?.id).toBe('a');
    expect(turns.begin('run-2')?.id).toBe('b');
    expect(turns.begin('run-3')).toBeNull();
  });
});

const message = (key: string, at: string): PlanChatEntry => ({
  key,
  role: 'person',
  text: `text of ${key}`,
  at,
  state: 'pending',
});
const ok: PipelineResult = { exitCode: 0, message: 'plan done' };

/** The turns of a run whose plan chat holds `pending` and whose plan decision is `decision`. */
function amending(pending: PlanChatEntry[], decision: 'approve' | null) {
  const left = [...pending];
  const chat = { pending: () => Promise.resolve([...left]) } as unknown as PlanChatStore;
  const body = JSON.stringify({ plan: { name: '', overview: '', items: ['a'], decision } });
  const documents = { latestBody: () => Promise.resolve(body) } as unknown as DocumentRepository;
  return { turns: new PlannerTurns(chat, documents), take: () => left.splice(0) };
}

describe('PlannerTurns.takesMessages', () => {
  const run = (split: boolean, currentStep: string, parent = false) =>
    ({ split, currentStep, workspace: 'ready', parentRunId: parent ? 7 : null }) as unknown as RunEntity;

  it('takes the message of a run after implement started, split or not', () => {
    const { turns } = amending([], null);
    expect(turns.takesMessages(run(true, 'implement'))).toBe(true);
    expect(turns.takesMessages(run(false, 'checks'))).toBe(true);
  });

  it('does not take it before implement or for a subtask', () => {
    const { turns } = amending([], null);
    expect(turns.takesMessages(run(true, 'plan'))).toBe(false);
    expect(turns.takesMessages(run(true, 'implement', true))).toBe(false);
  });
});

describe('PlannerTurns taking a turn', () => {
  it('runs the visit for the messages that wait and tells whether the plan changed', async () => {
    const kept = amending([message('a', '2026-01-01T00:00:00.000Z')], 'approve');
    expect(await kept.turns.take('run-1', async () => (kept.take(), ok), new Set())).toBe('kept');
    const changed = amending([message('a', '2026-01-01T00:00:00.000Z')], null);
    expect(await changed.turns.take('run-1', async () => (changed.take(), ok), new Set())).toBe('changed');
    expect(changed.turns.replying('run-1')).toBe(false);
  });

  it('does nothing when no message waits', async () => {
    const { turns } = amending([], 'approve');
    expect(await turns.take('run-1', () => Promise.reject(new Error('must not run')), new Set())).toBe('none');
  });

  it('takes one turn at a time: a second take while the visit runs does nothing', async () => {
    const { turns, take } = amending([message('a', '2026-01-01T00:00:00.000Z')], 'approve');
    let release: () => void = () => undefined;
    const first = turns.take(
      'run-1',
      () =>
        new Promise<PipelineResult>((resolve) => {
          release = () => {
            take();
            resolve(ok);
          };
        }),
      new Set(),
    );
    await Promise.resolve();
    expect(turns.replying('run-1')).toBe(true);
    expect(await turns.take('run-1', () => Promise.reject(new Error('must not run')), new Set())).toBe('none');
    release();
    expect(await first).toBe('kept');
  });

  it('keeps a message pending when the planner gave no usable reply, and does not ask for it again in the same drive', async () => {
    const { turns } = amending([message('a', '2026-01-01T00:00:00.000Z')], 'approve');
    const declined = new Set<string>();
    const failed: PipelineResult = { exitCode: 1, message: 'plan failed' };
    expect(await turns.take('run-1', () => Promise.resolve(failed), declined)).toBe('none');
    expect([...declined]).toEqual(['a']);
    expect(await turns.take('run-1', () => Promise.reject(new Error('must not run')), declined)).toBe('none');
    expect(turns.pending('run-1')).toEqual([]);
  });
});

describe('PlannerTurns background passes', () => {
  it('waits for a pass that is still running when the module closes', async () => {
    const turns = new PlannerTurns();
    const ended: string[] = [];
    let finish: () => void = () => undefined;
    turns.background(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            ended.push('pass');
            resolve();
          };
        }),
    );
    const closing = turns.onModuleDestroy().then(() => ended.push('closed'));
    await Promise.resolve();
    expect(ended).toEqual([]);
    finish();
    await closing;
    expect(ended).toEqual(['pass', 'closed']);
  });

  it('does not let a failed pass break the close', async () => {
    const turns = new PlannerTurns();
    turns.background(() => Promise.reject(new Error('host down')));
    await expect(turns.onModuleDestroy()).resolves.toBeUndefined();
  });
});

const question = (key: string, at: string): PlanChatEntry => ({
  key,
  role: 'planner',
  kind: 'question',
  from: 'implement',
  text: 'Keep the cursor or the page number?',
  at,
  state: 'pending',
});

/** A plan chat held in memory, and a planner that gives `reply` to the prompts it is asked. */
function asked(
  entries: PlanChatEntry[],
  reply: unknown,
  stored: Record<string, string> = {},
  run: Partial<RunEntity> = {},
) {
  const held = [...entries];
  const prompts: string[] = [];
  const documents = {
    latestBody: (_key: string, kind: string) => Promise.resolve(stored[kind] ?? null),
    putDocument: (_run: unknown, kind: string, body: string) => {
      stored[kind] = body;
      return Promise.resolve();
    },
  } as unknown as DocumentRepository;
  const released: unknown[] = [];
  const chat = {
    pending: () => Promise.resolve(held.filter((entry) => entry.role === 'person' && entry.state === 'pending')),
    pendingQuestions: () =>
      Promise.resolve(held.filter((entry) => entry.kind === 'question' && entry.state === 'pending')),
    pendingEscalations: () =>
      Promise.resolve(held.filter((entry) => entry.kind === 'escalation' && entry.state === 'pending')),
    read: () => Promise.resolve({ entries: held, revisions: [] }),
    appendEntry: (_key: string, entry: PlanChatEntry) => {
      if (!held.some((known) => known.key === entry.key)) held.push(entry);
      return Promise.resolve();
    },
    markTaken: (_key: string, keys: string[]) => {
      for (const entry of held) if (keys.includes(entry.key)) entry.state = 'taken';
      return Promise.resolve();
    },
  } as unknown as PlanChatStore;
  const conversation = {
    isReplying: () => false,
    visit: (_opened: unknown, prompt: (received: string | null) => string) => {
      prompts.push(prompt(null));
      return Promise.resolve(reply === null ? null : { value: reply });
    },
  } as unknown as PlanConversation;
  const runs = {
    findRun: () => Promise.resolve({ key: 'run-1', currentStep: 'implement', status: 'waiting', ...run }),
    release: (_run: unknown, change: unknown) => {
      released.push(change);
      return Promise.resolve();
    },
  };
  const clock = { now: () => 0, iso: () => '2026-01-01T00:01:00.000Z' };
  const turns = new PlannerTurns(chat, documents, conversation, runs as unknown as RunRepository, clock);
  return { turns, held, prompts, stored, released };
}

describe('PlannerTurns answering a step question', () => {
  const implementing = { split: false, currentStep: 'implement', workspace: 'ready', parentRunId: null } as RunEntity;

  it('puts a question and a message in the order they came, and leaves out what was declined', async () => {
    const { turns } = asked(
      [question('ask-1', '2026-01-01T00:00:05.000Z'), message('message-1', '2026-01-01T00:00:01.000Z')],
      null,
    );
    expect(await turns.next(implementing, new Set())).toBe('message');
    expect(await turns.next(implementing, new Set(['message-1']))).toBe('question');
    expect(await turns.next(implementing, new Set(['message-1', 'ask-1']))).toBeNull();
    const earlier = asked(
      [question('ask-1', '2026-01-01T00:00:00.000Z'), message('message-1', '2026-01-01T00:00:01.000Z')],
      null,
    );
    expect(await earlier.turns.next(implementing, new Set())).toBe('question');
  });

  it('records the planner answer for the step that asked and takes the question', async () => {
    const { turns, held, prompts } = asked([question('ask-1', '2026-01-01T00:00:05.000Z')], {
      reply: 'Cursor, as in the brief.',
    });
    const declined = new Set<string>();

    expect(await turns.answer('run-1', declined)).toBe(true);

    expect(held.find((entry) => entry.kind === 'answer')).toMatchObject({
      key: 'answer-ask-1',
      from: 'implement',
      role: 'planner',
      text: 'Cursor, as in the brief.',
      state: 'pending',
    });
    expect(held.find((entry) => entry.key === 'ask-1')?.state).toBe('taken');
    expect(prompts[0]).toContain('The implement step asks:\nKeep the cursor or the page number?');
    expect(prompts[0]).toContain('escalate');
    expect(prompts[0]).not.toContain('- plan (array');
    expect(await turns.hasQuestion('run-1')).toBe(false);
    expect(turns.replying('run-1')).toBe(false);
  });

  it('writes an escalated question for the person and leaves the run waiting for the answer', async () => {
    const { turns, held, stored, released } = asked([question('ask-1', '2026-01-01T00:00:05.000Z')], {
      reply: 'This is a product decision.',
      escalate: 'Which pagination do you want?',
    });
    const declined = new Set<string>();

    expect(await turns.answer('run-1', declined)).toBe(false);

    const line = 'implement asks: Which pagination do you want? (asked 2026-01-01T00:01:00.000Z)';
    expect(held.some((entry) => entry.kind === 'answer')).toBe(false);
    expect(held.find((entry) => entry.key === 'ask-1')?.state).toBe('taken');
    expect(held.find((entry) => entry.key === 'escalate-ask-1')).toMatchObject({
      kind: 'escalation',
      from: 'implement',
      text: 'Which pagination do you want?',
      state: 'pending',
    });
    expect(stored.questions).toBe(`- ${line}\n`);
    expect(JSON.parse(stored.question_parts)[0].parts.decide).toBe('Which pagination do you want?');
    expect(released).toEqual([{ status: 'waiting', facts: { needsAnswers: true } }]);
    expect(await turns.hasQuestion('run-1')).toBe(true);
    expect(await turns.next(implementing, new Set())).toBeNull();
  });

  describe("a subtask's implement question", () => {
    const subtask = { ...implementing, parentRunId: 4 } as RunEntity;

    it('is taken by its own planner, which answers it as for any run', async () => {
      const { turns, held } = asked([question('ask-1', '2026-01-01T00:00:05.000Z')], { reply: 'Cursor.' }, {}, subtask);
      expect(await turns.next(subtask, new Set())).toBe('question');

      expect(await turns.answer('run-1', new Set())).toBe(true);

      expect(held.find((entry) => entry.kind === 'answer')).toMatchObject({ from: 'implement', text: 'Cursor.' });
    });

    it('leaves what its planner escalates pending for the parent, and never asks a person', async () => {
      const { turns, held, stored, released } = asked(
        [question('ask-1', '2026-01-01T00:00:05.000Z')],
        { reply: 'Not mine to decide.', escalate: 'Which pagination do you want?' },
        {},
        subtask,
      );

      expect(await turns.answer('run-1', new Set())).toBe(false);

      expect(stored.questions).toBeUndefined();
      expect(stored.question_parts).toBeUndefined();
      expect(asksForStarter({ entries: held }).map((entry) => entry.text)).toEqual(['Which pagination do you want?']);
      expect(released).toEqual([
        { status: 'waiting', reason: { code: 'ASKS_PLANNER', message: 'implement asks the planner of the parent' } },
      ]);
      expect(await turns.hasQuestion('run-1')).toBe(true);
      expect(await turns.next(subtask, new Set())).toBeNull();
    });
  });

  describe('the answer of the person to an escalated question', () => {
    const escalate = (): PlanChatEntry => ({
      key: 'escalate-ask-1',
      role: 'planner',
      kind: 'escalation',
      from: 'implement',
      text: 'Which pagination do you want?',
      at: '2026-01-01T00:01:00.000Z',
      state: 'pending',
    });
    const line = 'implement asks: Which pagination do you want? (asked 2026-01-01T00:01:00.000Z)';
    const open = (answer: string): Record<string, string> => ({
      questions: `- ${line}\n`,
      answers: `question: ${line}\nanswer: ${answer}\n`,
    });

    it('is a turn once the line is answered, in the order of the entries, and not before', async () => {
      const waiting = asked([escalate()], null, { questions: `- ${line}\n` });
      expect(await waiting.turns.next(implementing, new Set())).toBeNull();
      const given = asked([escalate(), message('message-1', '2026-01-01T00:02:00.000Z')], null, open('Cursor'));
      expect(await given.turns.next(implementing, new Set())).toBe('answer');
      expect(await given.turns.next(implementing, new Set(['escalate-ask-1']))).toBe('message');
    });

    it('is read by the planner, handed to the step that asked, and closes the question', async () => {
      const { turns, held, prompts, stored } = asked(
        [{ ...question('ask-1', '2026-01-01T00:00:05.000Z'), state: 'taken' }, escalate()],
        { reply: 'Use the cursor, the person decided.' },
        open('Cursor'),
      );
      const declined = new Set<string>();

      expect(await turns.settle('run-1', declined)).toBe(true);

      expect(prompts[0]).toContain('The implement step had asked:\nKeep the cursor or the page number?');
      expect(prompts[0]).toContain('The person answered:\nCursor');
      expect(held.find((entry) => entry.kind === 'answer')).toMatchObject({
        key: 'answer-ask-1',
        from: 'implement',
        text: 'Use the cursor, the person decided.',
        state: 'pending',
      });
      expect(held.find((entry) => entry.key === 'escalate-ask-1')?.state).toBe('taken');
      expect(stored.questions).toBe('');
      expect(await turns.hasQuestion('run-1')).toBe(false);
      expect([...declined]).toEqual([]);
    });

    it('stays when the planner gave no usable reply, and is not asked again in the same drive', async () => {
      const { turns, held } = asked([escalate()], null, open('Cursor'));
      const declined = new Set<string>();

      expect(await turns.settle('run-1', declined)).toBe(false);

      expect(held.find((entry) => entry.key === 'escalate-ask-1')?.state).toBe('pending');
      expect(await turns.hasQuestion('run-1')).toBe(true);
      expect(await turns.next(implementing, declined)).toBeNull();
    });
  });

  it('keeps the question when the planner gave no usable answer', async () => {
    const { turns, held } = asked([question('ask-1', '2026-01-01T00:00:05.000Z')], null);
    const declined = new Set<string>();

    expect(await turns.answer('run-1', declined)).toBe(false);

    expect(held.filter((entry) => entry.kind !== 'question')).toEqual([]);
    expect([...declined]).toEqual(['ask-1']);
    expect(turns.replying('run-1')).toBe(false);
  });
});
