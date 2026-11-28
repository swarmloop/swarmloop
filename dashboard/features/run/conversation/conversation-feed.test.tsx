import type { ReactNode } from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { FlowView } from '@contract/api';
import type { PlanChatEntry } from '@contract/plan-chat';
import { getStepEvents } from '../../../lib/endpoints';
import { LiveBridgeProvider } from '../../shell';
import { expectNoRawJson } from '../../../test/raw-json';
import { flowView } from '../../../test/fixtures';
import { QueryWrapper } from '../../../test/query-wrapper';
import { stepEvent } from '../../../test/step-events';
import { type AgentTalk, type FeedEntry } from './conversation-words';
import { ConversationFeed } from './conversation-feed';
import { feedEntries } from './talk-entries';

vi.mock('../../../lib/endpoints', () => ({ getStepEvents: vi.fn(), resumeRun: vi.fn() }));
vi.mock('../../../lib/live', async () => (await import('../../../test/fake-socket')).fakeLive());

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryWrapper>
      <LiveBridgeProvider>{children}</LiveBridgeProvider>
    </QueryWrapper>
  );
}

const entry = (key: string, role: PlanChatEntry['role'], text: string, state: PlanChatEntry['state'] = 'taken') =>
  ({ key, role, text, state, at: '2026-11-15T07:11:43.444Z' }) satisfies PlanChatEntry;

function feed(flow: FlowView, entries: FeedEntry[] = [], onResume = vi.fn()) {
  return render(<ConversationFeed flow={flow} entries={entries} onResume={onResume} />, { wrapper: Wrapper });
}

const conversation = (overrides: Partial<NonNullable<FlowView['conversation']>> = {}) => ({
  composer: 'plan' as const,
  replying: false,
  entries: [],
  revisions: [],
  questions: [],
  ...overrides,
});

describe('ConversationFeed', () => {
  it('shows the entries in order: the person, the planner as markdown, and a pending message as pending', () => {
    const entries = [
      entry('message-1', 'person', 'Split it by service'),
      entry('reply-1', 'planner', 'Done:\n\n- first\n- second'),
      entry('message-2', 'person', 'Also add logging', 'pending'),
    ];
    feed(flowView({ conversation: conversation({ entries }) }), entries);

    const articles = screen.getAllByRole('article');
    expect(articles.map((item) => item.textContent)).toEqual([
      expect.stringContaining('Split it by service'),
      expect.stringContaining('first'),
      expect.stringContaining('Also add logging'),
    ]);
    expect(within(articles[1]).getAllByRole('listitem')).toHaveLength(2);
    expect(within(articles[2]).getByText('Pending')).toBeInTheDocument();
    expect(within(articles[0]).queryByText('Pending')).toBeNull();
  });

  it('says in plain words that a pending message waits for the model host, since when and until when', () => {
    const waiting: PlanChatEntry = {
      ...entry('message-3', 'person', 'Please plan it small', 'pending'),
      wait: {
        on: 'model-host',
        since: '2026-11-15T07:12:00.000Z',
        message: 'the model host did not answer',
        retryAt: '2026-11-15T07:20:00.000Z',
      },
    };
    feed(flowView({ conversation: conversation({ entries: [waiting] }) }), [waiting]);

    const [article] = screen.getAllByRole('article');
    const time = (iso: string) => new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' }).format(new Date(iso));
    expect(within(article).getByText('Pending')).toBeInTheDocument();
    expect(article.textContent).toContain(
      `The planner's reply waits for the model host since ${time(waiting.wait!.since)}: the model host did not answer. Next try at ${time(waiting.wait!.retryAt)}.`,
    );
  });

  it('streams the reply of the running plan visit, without its result block', async () => {
    vi.mocked(getStepEvents).mockResolvedValue({
      events: [
        stepEvent(1, { kind: 'attempt.started', stepKind: 'agent', agent: null }, { step: 'plan' }),
        stepEvent(2, { kind: 'agent.message', text: 'Old words', chars: 9 }, { step: 'plan' }),
        stepEvent(3, { kind: 'attempt.started', stepKind: 'agent', agent: null }, { step: 'plan' }),
        stepEvent(
          4,
          { kind: 'agent.message', text: 'Splitting **now**\n```json\n{"reply":', chars: 30 },
          { step: 'plan' },
        ),
      ],
      next: null,
    });
    feed(flowView({ revision: 3, conversation: conversation({ replying: true }) }));

    expect(await screen.findByText('now')).toBeInTheDocument();
    expect(screen.queryByText(/Old words/)).toBeNull();
    expect(screen.queryByText(/"reply"/)).toBeNull();
  });

  it('shows a question for the person in f25 shape, marked Question for you, with no answer field', () => {
    const parts = {
      decide: 'Is the requirements review right that Do 4 is missing?',
      sides: [
        { who: 'requirements', text: 'Do 4 is missing' },
        { who: 'implement', text: 'Implement did not answer this point' },
      ],
      full: Array.from({ length: 50 }, (_, index) => `${index + 1}. Do ${index + 1} is met`).join('\n'),
      askedAt: '2026-11-15T07:11:43.444Z',
    };
    const { container } = feed(
      flowView({
        status: 'waiting',
        resume: 'need-answers',
        items: [{ kind: 'question', id: 'q1', label: 'raw label (asked 2026-11-15T07:11:43.444Z)', answer: '', parts }],
      }),
    );

    expect(screen.getByText('Question for you')).toBeInTheDocument();
    expect(screen.getByText(parts.decide)).toBeInTheDocument();
    expect(screen.getByText('Implement did not answer this point')).toBeInTheDocument();
    expect(screen.queryByText(/Do 5 is met/)).not.toBeVisible();
    const details = container.querySelector('details') as HTMLDetailsElement;
    expect(details.querySelector('summary')?.textContent).toBe('Show the whole review');
    expect(details.querySelectorAll('li')).toHaveLength(50);
    expect(container.textContent).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('titles a question the backlog planner holds Asked the planner, not Question for you', () => {
    feed(
      flowView({
        status: 'waiting',
        items: [{ kind: 'question', id: 'q1', label: 'Which database?', answer: '', holder: 'planner' }],
      }),
    );

    expect(screen.getByText('Asked the planner')).toBeInTheDocument();
    expect(screen.queryByText('Question for you')).toBeNull();
    expect(screen.getByText('Which database?')).toBeInTheDocument();
  });

  it('shows the line of the planner as a side of the card of a question it passed on, still titled Question for you', () => {
    feed(
      flowView({
        status: 'waiting',
        items: [
          {
            kind: 'question',
            id: 'q1',
            label: 'Which database?',
            answer: '',
            passedOn: 'Only you can choose it.',
            parts: {
              decide: 'Which database?',
              sides: [{ who: 'backlog planner', text: 'Only you can choose it.' }],
              full: '',
              askedAt: '2026-01-01T00:00:00.000Z',
            },
          },
        ],
      }),
    );

    const line = screen.getByText('Only you can choose it.');
    const title = screen.getByText('Question for you');
    expect(screen.queryByText('Asked the planner')).toBeNull();
    expect(screen.queryByText(/The planner passed this on/)).toBeNull();
    expect(screen.getByText('backlog planner')).toBeInTheDocument();
    expect(title.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      screen.getByText('Which database?').compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('names who asks on each question card, and leads each line of talk to its own card', async () => {
    const user = userEvent.setup({ delay: null });
    // jsdom has no scrollIntoView, so removing the stub restores the window as it was.
    Element.prototype.scrollIntoView = () => undefined;
    try {
      const asked = (n: number, from: string, text: string): PlanChatEntry[] => [
        { ...entry(`ask-${n}`, 'planner', `Question ${n}`), kind: 'question', from },
        { ...entry(`escalate-ask-${n}`, 'planner', text), kind: 'escalation', from },
      ];
      const entries = [
        ...asked(1, 'code-review-quality', 'Keep the helper?'),
        ...asked(2, 'implement', 'Which store?'),
        ...asked(3, 'implement', 'Same decision as the open one'),
      ];
      const card = (id: string, decide: string, extra: object) => ({
        kind: 'question' as const,
        id,
        label: id,
        answer: '',
        parts: { decide, sides: [], full: '', askedAt: '2026-11-15T07:11:43.444Z', ...extra },
      });
      feed(
        flowView({
          status: 'waiting',
          items: [
            card('q1', 'Keep the helper?', { asker: 'code-review-quality', entry: 'escalate-ask-1' }),
            card('q2', 'Which store?', { asker: 'implement', entry: 'escalate-ask-2' }),
            card('q3', 'Same decision as the open one', {}),
          ],
        }),
        feedEntries(entries),
      );

      const cardOf = (asker: string) => screen.getByText(asker).closest('article');
      expect(cardOf('The quality reviewer asks')).not.toBeNull();
      expect(cardOf('Implement asks')).not.toBeNull();
      expect(screen.getAllByText(/ asks$/)).toHaveLength(2);
      const links = screen.getAllByRole('button', { name: 'Go to the question' });
      expect(links).toHaveLength(2);

      await user.click(links[0]);
      expect(cardOf('The quality reviewer asks')).toHaveFocus();
      await user.click(links[1]);
      expect(cardOf('Implement asks')).toHaveFocus();
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('left-aligns a talk line and a question, folds a 20-line question under its asker line and keeps the talk link', async () => {
    const user = userEvent.setup({ delay: null });
    Element.prototype.scrollIntoView = () => undefined;
    try {
      const decide = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join('\n');
      const entries: FeedEntry[] = [
        { ...entry('ask-1', 'planner', 'Question 1'), kind: 'question', from: 'implement' },
        { ...entry('escalate-ask-1', 'planner', 'Which store?'), kind: 'escalation', from: 'implement' },
        entry('message-1', 'person', 'Use the cache'),
        {
          key: 'talk-1',
          role: 'talk',
          at: '2026-11-15T07:11:43.444Z',
          who: 'Implement',
          to: 'the planner',
          asked: 'Which store?',
          escalated: true,
          escalation: 'escalate-ask-1',
        },
      ];
      feed(
        flowView({
          status: 'waiting',
          items: [
            {
              kind: 'question',
              id: 'q1',
              label: 'q1',
              answer: '',
              parts: {
                decide,
                sides: [],
                full: '',
                askedAt: '2026-11-15T07:11:43.444Z',
                asker: 'implement',
                entry: 'escalate-ask-1',
              },
            },
          ],
        }),
        entries,
      );

      const card = screen.getByText('Implement asks').closest('article')!;
      expect(screen.getByText('Implement asks').parentElement!.parentElement).toHaveStyle({ textAlign: 'left' });
      expect(screen.getByRole('button', { name: /Implement asked the planner/ })).toHaveStyle({ textAlign: 'left' });
      expect(within(card).getByText('Implement asks')).toBeVisible();
      const folded = screen.getByText(/line 20/).parentElement!;
      expect(getComputedStyle(folded.parentElement!).display).toBe('-webkit-box');
      expect(getComputedStyle(folded).display).toBe('block');
      await user.click(within(card).getByRole('button', { name: 'Show all' }));
      expect(within(card).getByRole('button', { name: 'Show less' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Go to the question' })).toBeVisible();
      expect(screen.getByText('Use the cache').parentElement).toHaveStyle({ textAlign: 'left' });
    } finally {
      Reflect.deleteProperty(Element.prototype, 'scrollIntoView');
    }
  });

  it('renders the label of a question without parts as markdown, and shows a paste request the same way', () => {
    feed(
      flowView({
        status: 'waiting',
        items: [
          { kind: 'question', id: 'q', label: 'Which **database**?', answer: '' },
          { kind: 'paste', id: 'p1', label: 'Config', answer: '' },
        ],
      }),
    );

    expect(screen.getByText('database').tagName).toBe('STRONG');
    expect(screen.getAllByText('Question for you')).toHaveLength(2);
    expect(screen.getByText('Please paste: Config')).toBeInTheDocument();
  });

  it('shows talk between agents as a one-line info line that opens on click', async () => {
    const user = userEvent.setup({ delay: null });
    const talk: AgentTalk = {
      key: 'talk-1',
      role: 'talk',
      at: '2026-11-15T07:11:43.444Z',
      who: 'Implement',
      to: 'the planner',
      asked: 'Which pagination should I keep?',
      answered: 'Cursor, as in the brief.',
    };
    feed(flowView({ conversation: conversation({ entries: [] }) }), [talk]);

    const line = screen.getByRole('button', {
      name: /Implement asked the planner: Which pagination should I keep; the answer was: Cursor, as in the brief\./,
    });
    expect(line).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Answer: Cursor, as in the brief.')).toBeNull();
    await user.click(line);
    expect(line).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Question: Which pagination should I keep?')).toBeInTheDocument();
    expect(screen.getByText('Answer: Cursor, as in the brief.')).toBeInTheDocument();
  });

  it("shows a person's message to a subtask and its reply as one info line with a link to the subtask", () => {
    const info: PlanChatEntry = {
      ...entry('info-1', 'planner', 'Maksym → git-retry: use a cursor'),
      kind: 'info',
      reply: 'Done, the page uses a cursor.',
      link: 'epic-1-git-retry',
    };
    feed(flowView({ conversation: conversation({ entries: [info] }) }), [info]);

    expect(
      screen.getByText('Maksym → git-retry: use a cursor Reply: Done, the page uses a cursor.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open epic-1-git-retry' })).toHaveAttribute(
      'href',
      '/runs/epic-1-git-retry',
    );
    expect(screen.queryByText('Message')).toBeNull();
  });

  it('shows a usage-limit wait as an info line with the local time it goes on', () => {
    const limit = { runtime: 'claude', resumesAt: '2026-11-08T21:51:00.000Z' };
    feed(
      flowView({
        status: 'waiting',
        state: 'waiting',
        stateReason: { code: 'RUNTIME_LIMIT', message: 'Claude hit its usage limit.', limit },
      }),
    );

    expect(
      screen.getByText(/^Waiting for the claude usage limit\. The run goes on at \d\d:\d\d\.$/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/RUNTIME_LIMIT|2026-11-08/)).toBeNull();
  });

  it('shows a failed step as a card with its reason in plain words, and Resume', async () => {
    const user = userEvent.setup({ delay: null });
    const onResume = vi.fn();
    const { container } = feed(
      flowView({
        status: 'failed',
        resume: 'ready',
        state: 'failed',
        reason: 'STEP_FAILED: the agent stopped at 2026-11-15T07:11:43.444Z',
        stateReason: { code: 'STEP_FAILED', message: 'the agent stopped' },
      }),
      [],
      onResume,
    );

    const card = screen.getByRole('region', { name: 'Problem' });
    expect(card).toHaveTextContent(/^Run one is running\.the agent stopped at \d\d:\d\d(Resume)?/);
    expect(container.textContent).not.toMatch(/STEP_FAILED|\d{4}-\d{2}-\d{2}T/);
    await user.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResume).toHaveBeenCalledOnce();
  });

  it('shows a split run that waits for its subtasks as an info line, not a problem', () => {
    feed(
      flowView({
        status: 'waiting',
        resume: 'ready',
        state: 'waiting',
        actions: ['resume'],
        sentence: 'Waiting for subtasks: 0/6 merged · 3 running · 3 waiting',
        stateReason: { code: 'SUBTASKS_RUNNING', message: 'm' },
      }),
    );

    expect(screen.getByText('Waiting for subtasks: 0/6 merged · 3 running · 3 waiting')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Problem' })).toBeNull();
  });

  it.each([
    ['a git access wait', 'waiting', 'GIT_AUTH'],
    ['a stalled run', 'waiting', 'STALLED'],
    ['a failed run', 'failed', 'STEP_FAILED'],
    ['a blocked run', 'blocked', 'LOOP_LIMIT'],
  ] as const)('shows %s as a problem with Resume', (_name, status, code) => {
    feed(
      flowView({
        status,
        resume: 'ready',
        actions: ['resume'],
        stateReason: { code, message: 'm' },
      }),
    );

    const card = screen.getByRole('region', { name: 'Problem' });
    expect(within(card).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });

  it('lists the jobs CI did not run and offers Re-run CI instead of Resume', async () => {
    const user = userEvent.setup({ delay: null });
    const onResume = vi.fn();
    const line = 'CI_NOT_RUN: CI did not run server-test, autofix: spending limit https://ci.example/9';
    feed(
      flowView({
        status: 'blocked',
        resume: 'ready',
        reason: `${line}\njob: server-test\njob: autofix\n`,
        paths: [{ repo: 'swarmloop', path: 'server/src/a.ts' }],
        stateReason: { code: 'CI_NOT_RUN', message: line },
      }),
      [],
      onResume,
    );

    expect(screen.getByText(line.replace('CI_NOT_RUN: ', ''))).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'server-test',
      'autofix',
      'swarmloop/server/src/a.ts',
    ]);
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Re-run CI' }));
    expect(onResume).toHaveBeenCalledOnce();
  });

  it('disables Resume while the run is not ready, and folds a long report under one line', () => {
    const report = Array.from({ length: 30 }, (_, index) => `line ${index}`).join('\n');
    feed(flowView({ status: 'failed', resume: 'running', reason: report }));

    expect(screen.getByRole('button', { name: 'Resume' })).toBeDisabled();
    expect(screen.getByText('Show the whole report')).toBeInTheDocument();
    expect(screen.getByText(/line 20/)).not.toBeVisible();
  });

  it('renders no JSON, field name, step id or ISO time for a conversation with a question, a talk and a failed step', () => {
    const entries: FeedEntry[] = [
      entry('message-1', 'person', 'Please split it'),
      entry('reply-1', 'planner', 'Yes, I split it in two.'),
      {
        key: 'talk-1',
        role: 'talk',
        at: '2026-11-15T07:11:43.444Z',
        who: 'Implement',
        to: 'the planner',
        asked: 'Keep cursor pagination?',
      },
    ];
    const { container } = feed(
      flowView({
        status: 'failed',
        resume: 'ready',
        reason: 'CHECK_FAILED: a required check failed',
        items: [{ kind: 'question', id: 'question-7', label: 'Which database?', answer: '' }],
        stateReason: { code: 'CHECK_FAILED', message: 'a required check failed' },
      }),
      entries,
    );

    expectNoRawJson(container);
    expect(container.textContent).not.toMatch(/CHECK_FAILED|question-7|message-1|talk-1|\d{4}-\d{2}-\d{2}T/);
  });

  describe('as one timeline', () => {
    const at = (time: string) => `2026-11-15T${time}:00.000Z`;
    const sized = (node: HTMLElement, scrollHeight: number, scrollTop = 0) => {
      Object.defineProperty(node, 'scrollHeight', { configurable: true, value: scrollHeight });
      Object.defineProperty(node, 'clientHeight', { configurable: true, value: 200 });
      node.scrollTop = scrollTop;
    };
    const asked = (id: string, time: string) => ({
      kind: 'question' as const,
      id,
      text: id,
      answer: '',
      askedAt: at(time),
    });

    it('shows a question asked before an answer first, as Answered with its answer under it', () => {
      const entries = [{ ...entry('message-1', 'person', 'Use Postgres'), at: at('12:44') }];
      feed(
        flowView({
          updatedAt: at('13:00'),
          conversation: conversation({ entries, questions: [asked('q1', '12:25')] }),
          items: [{ kind: 'question', id: 'q1', label: 'Which database?', answer: 'Use Postgres' }],
        }),
        entries,
      );
      const articles = screen.getAllByRole('article');
      expect(articles[0].textContent).toContain('Answered');
      expect(articles[0].textContent).toContain('Which database?');
      expect(articles[0].textContent).toContain('Use Postgres');
      expect(articles[1].textContent).toContain('Use Postgres');
      expect(screen.queryByText('Question for you')).toBeNull();
    });

    it('shows an open question above a later message', () => {
      const entries = [{ ...entry('message-1', 'person', 'Later words'), at: at('12:44') }];
      feed(
        flowView({
          conversation: conversation({ entries, questions: [asked('q1', '12:25')] }),
          items: [{ kind: 'question', id: 'q1', label: 'Which database?', answer: '' }],
        }),
        entries,
      );
      const articles = screen.getAllByRole('article');
      expect(articles[0].textContent).toContain('Question for you');
      expect(articles[1].textContent).toContain('Later words');
    });

    it('opens at the newest entry, follows a new one at the bottom, and keeps the view when scrolled up', () => {
      const entries = [entry('m1', 'person', 'One')];
      const flow = flowView({ conversation: conversation({ entries }) });
      const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(1000);
      const view = feed(flow, entries);
      height.mockRestore();
      const log = screen.getByRole('log', { name: 'Conversation' });
      expect(log.scrollTop).toBe(1000);

      const more = [...entries, entry('m2', 'person', 'Two')];
      sized(log, 1200, 1000);
      view.rerender(<ConversationFeed flow={flow} entries={more} onResume={vi.fn()} />);
      expect(log.scrollTop).toBe(1200);
      expect(screen.queryByRole('button', { name: 'New messages ↓' })).toBeNull();

      sized(log, 1200, 100);
      fireEvent.scroll(log);
      const most = [...more, entry('m3', 'person', 'Three')];
      sized(log, 1400, 100);
      view.rerender(<ConversationFeed flow={flow} entries={most} onResume={vi.fn()} />);
      expect(log.scrollTop).toBe(100);
      fireEvent.click(screen.getByRole('button', { name: 'New messages ↓' }));
      expect(log.scrollTop).toBe(1400);
      expect(screen.queryByRole('button', { name: 'New messages ↓' })).toBeNull();
    });

    it('keeps the view and the New messages button when a reply starts or ends', () => {
      vi.mocked(getStepEvents).mockResolvedValue({ events: [], next: null });
      const entries = [entry('m1', 'person', 'One')];
      const idle = flowView({ conversation: conversation({ entries }) });
      const view = feed(idle, entries);
      const log = screen.getByRole('log', { name: 'Conversation' });
      sized(log, 1200, 100);
      fireEvent.scroll(log);
      const more = [...entries, entry('m2', 'person', 'Two')];
      sized(log, 1400, 100);
      view.rerender(<ConversationFeed flow={idle} entries={more} onResume={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'New messages ↓' })).toBeInTheDocument();

      const replying = flowView({ conversation: conversation({ entries, replying: true }) });
      view.rerender(<ConversationFeed flow={replying} entries={more} onResume={vi.fn()} />);
      view.rerender(<ConversationFeed flow={idle} entries={more} onResume={vi.fn()} />);
      expect(screen.getByRole('log', { name: 'Conversation' })).toBe(log);
      expect(log.scrollTop).toBe(100);
      expect(screen.getByRole('button', { name: 'New messages ↓' })).toBeInTheDocument();
    });

    it('keeps a streaming reply as the last entry, after a later message and an open question', async () => {
      vi.mocked(getStepEvents).mockResolvedValue({ events: [], next: null });
      const entries = [{ ...entry('m1', 'person', 'One'), at: at('12:44') }];
      feed(
        flowView({
          updatedAt: at('12:30'),
          conversation: conversation({ replying: true, entries, questions: [asked('q1', '12:25')] }),
          items: [{ kind: 'question', id: 'q1', label: 'Which database?', answer: '' }],
        }),
        entries,
      );
      const articles = screen.getAllByRole('article');
      expect(articles[0].textContent).toContain('Question for you');
      expect(articles[1].textContent).toContain('One');
      expect(articles.at(-1)?.textContent).toContain('Writing');
    });
  });
});
