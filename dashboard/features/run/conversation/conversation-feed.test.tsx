import type { ReactNode } from 'react';
import { render, screen, within } from '@testing-library/react';
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
});
