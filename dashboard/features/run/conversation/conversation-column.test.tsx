import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FlowView } from '@contract/api';
import type { PlanChatEntry } from '@contract/plan-chat';
import {
  getSession,
  getStepEvents,
  listProjects,
  listRemote,
  sendPlanChat,
  ticketKeys,
  uploadFile,
} from '../../../lib/endpoints';
import { LiveBridgeProvider } from '../../shell';
import { flowView } from '../../../test/fixtures';
import { QueryWrapper } from '../../../test/query-wrapper';
import { mediaWidth } from '../../../test/viewport';
import { ConversationColumn } from './conversation-column';

vi.mock('../../../lib/endpoints', () => ({
  getSession: vi.fn(),
  getStepEvents: vi.fn(),
  sendPlanChat: vi.fn(),
  listProjects: vi.fn(),
  listRemote: vi.fn(),
  ticketKeys: vi.fn(),
  uploadFile: vi.fn(),
  createRun: vi.fn(),
}));
vi.mock('../../../lib/live', async () => (await import('../../../test/fake-socket')).fakeLive());

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryWrapper>
      <LiveBridgeProvider>{children}</LiveBridgeProvider>
    </QueryWrapper>
  );
}

const entry = (key: string, role: PlanChatEntry['role'], text: string): PlanChatEntry => ({
  key,
  role,
  text,
  state: 'taken',
  at: '2026-11-15T07:11:43.444Z',
});

function flowWith(
  conversation: Partial<NonNullable<FlowView['conversation']>> = {},
  overrides: Partial<FlowView> = {},
): FlowView {
  return flowView({
    conversation: { composer: 'plan', replying: false, entries: [], revisions: [], questions: [], ...conversation },
    ...overrides,
  });
}

function column(flow: FlowView, onChange = vi.fn(), onResume = vi.fn()) {
  return <ConversationColumn flow={flow} onResume={onResume} onChange={onChange} />;
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(getSession).mockResolvedValue({ user: 'alice' });
  vi.mocked(getStepEvents).mockResolvedValue({ events: [], next: null });
  vi.mocked(listProjects).mockResolvedValue({ projects: [] });
  vi.mocked(listRemote).mockResolvedValue({
    repositories: [],
    owners: [],
    reason: null,
    allowedNames: [],
    loading: false,
    error: null,
  });
  vi.mocked(ticketKeys).mockResolvedValue({ keys: [] });
  vi.mocked(uploadFile).mockImplementation((_file, name) => Promise.resolve({ id: `id-${name}`, name, size: 3 }));
});

// One paste is one change event; typing it key by key re-renders the column per character.
async function pasteMessage(user: UserEvent, box: HTMLElement, text: string): Promise<void> {
  await user.click(box);
  await user.paste(text);
}

describe('ConversationColumn on a wide window', () => {
  mediaWidth(1280);

  it('shows a step question and its answer as one info line and not as replies of the planner', () => {
    const at = '2026-11-15T07:11:43.444Z';
    const entries: PlanChatEntry[] = [
      {
        key: 'ask-implement-a1',
        role: 'planner',
        kind: 'question',
        from: 'implement',
        text: 'Which pagination?',
        at,
        state: 'taken',
      },
      {
        key: 'answer-ask-implement-a1',
        role: 'planner',
        kind: 'answer',
        from: 'implement',
        text: 'Cursor.',
        at,
        state: 'taken',
      },
    ];

    render(column(flowWith({ entries })), { wrapper: Wrapper });

    expect(
      screen.getByText('Implement asked the planner: Which pagination; the answer was: Cursor.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Reply')).not.toBeInTheDocument();
  });

  it('is a column 360 px wide that may go from 320 to 400', () => {
    render(column(flowWith()), { wrapper: Wrapper });

    expect(screen.getByRole('complementary', { name: 'Conversation' })).toHaveStyle({
      width: '360px',
      minWidth: '320px',
      maxWidth: '400px',
    });
  });

  it('collapses to a rail, shows a mark when something new came, and remembers the state per login', async () => {
    const user = userEvent.setup({ delay: null });
    const first = flowWith({ entries: [entry('m1', 'person', 'hello')] });
    const { rerender, unmount } = render(column(first), { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: 'Collapse the conversation' }));
    expect(screen.getByRole('complementary', { name: 'Conversation rail' })).toBeInTheDocument();
    expect(screen.queryByTestId('new-mark')).toBeNull();

    rerender(column(flowWith({ entries: [entry('m1', 'person', 'hello'), entry('r1', 'planner', 'hi')] })));
    expect(screen.getByTestId('new-mark')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open the conversation, something new' })).toBeInTheDocument();
    expect(localStorage.getItem('swarmloop.conversation.alice')).toBe('closed');

    unmount();
    render(column(first), { wrapper: Wrapper });
    expect(await screen.findByRole('complementary', { name: 'Conversation rail' })).toBeInTheDocument();
  });

  it('opens for another login, and opens again from the rail', async () => {
    const user = userEvent.setup({ delay: null });
    localStorage.setItem('swarmloop.conversation.alice', 'closed');
    vi.mocked(getSession).mockResolvedValue({ user: 'bob' });
    render(column(flowWith()), { wrapper: Wrapper });

    expect(await screen.findByRole('complementary', { name: 'Conversation' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Collapse the conversation' }));
    await user.click(screen.getByRole('button', { name: 'Open the conversation' }));
    expect(screen.getByRole('complementary', { name: 'Conversation' })).toBeInTheDocument();
    expect(localStorage.getItem('swarmloop.conversation.bob')).toBe('open');
  });

  it('marks the rail when a question for the person comes', async () => {
    const user = userEvent.setup({ delay: null });
    const { rerender } = render(column(flowWith()), { wrapper: Wrapper });
    await user.click(screen.getByRole('button', { name: 'Collapse the conversation' }));

    rerender(
      column(
        flowWith(
          { questions: [{ kind: 'question', id: 'q1', text: 'Which database?', answer: '' }] },
          { status: 'waiting', items: [{ kind: 'question', id: 'q1', label: 'Which database?', answer: '' }] },
        ),
      ),
    );

    expect(screen.getByTestId('new-mark')).toBeInTheDocument();
  });

  it('marks the rail at load when the run needs the person and the column was collapsed earlier', async () => {
    localStorage.setItem('swarmloop.conversation.alice', 'closed');
    const flow = flowWith({}, { status: 'failed', resume: 'ready', reason: 'the check failed' });
    render(column(flow), { wrapper: Wrapper });

    expect(await screen.findByRole('complementary', { name: 'Conversation rail' })).toBeInTheDocument();
    expect(screen.getByTestId('new-mark')).toBeInTheDocument();
  });

  it('shows no mark at load for a collapsed run that needs nothing', async () => {
    localStorage.setItem('swarmloop.conversation.alice', 'closed');
    render(column(flowWith()), { wrapper: Wrapper });

    expect(await screen.findByRole('complementary', { name: 'Conversation rail' })).toBeInTheDocument();
    expect(screen.queryByTestId('new-mark')).toBeNull();
  });

  it('sends the message to the planner, clears the box and hands the new run to onChange', async () => {
    const user = userEvent.setup({ delay: null });
    const next = flowWith({ entries: [entry('m1', 'person', 'split it')] });
    vi.mocked(sendPlanChat).mockResolvedValue(next);
    const onChange = vi.fn();
    render(column(flowWith(), onChange), { wrapper: Wrapper });
    const box = screen.getByRole('textbox', { name: 'Message to the planner' });

    expect(screen.getByText('goes into the plan')).toBeInTheDocument();
    await pasteMessage(user, box, 'split it');
    await user.keyboard('{Control>}{Enter}{/Control}');

    await waitFor(() => expect(onChange).toHaveBeenCalledWith(next));
    expect(sendPlanChat).toHaveBeenCalledWith('run-1', 'split it', []);
    expect(screen.getByRole('textbox', { name: 'Message to the planner' })).toHaveValue('');
  });

  it('shows why a message was not sent', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(sendPlanChat).mockRejectedValue(new Error('the run is busy'));
    render(column(flowWith()), { wrapper: Wrapper });

    await pasteMessage(user, screen.getByRole('textbox', { name: 'Message to the planner' }), 'hi');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('the run is busy');
  });

  it('sends a pasted image and a dropped file as chips', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(sendPlanChat).mockResolvedValue(flowWith());
    render(column(flowWith()), { wrapper: Wrapper });
    const box = screen.getByRole('textbox', { name: 'Message to the planner' });
    await pasteMessage(user, box, 'see');

    fireEvent.paste(box, { clipboardData: { files: [new File(['a'], 'shot.png', { type: 'image/png' })] } });
    expect(await screen.findByText('shot.png')).toBeVisible();
    fireEvent.drop(box, { dataTransfer: { files: [new File(['b'], 'log.txt')] } });
    expect(await screen.findByText('log.txt')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(sendPlanChat).toHaveBeenCalledWith('run-1', 'see', ['id-shot.png', 'id-log.txt']));
  });

  it('keeps the height of a streaming reply, so nothing shifts while it grows', async () => {
    const flow = flowWith({ replying: true }, { revision: 1 });
    const { rerender } = render(column(flow), { wrapper: Wrapper });
    const live = await screen.findByText('The planner is replying…');
    const frame = live.closest('[aria-live]');
    expect(frame).toHaveStyle({ minHeight: '160px' });

    rerender(column({ ...flow, revision: 2 }));
    expect(live.closest('[aria-live]')).toHaveStyle({ minHeight: '160px' });
  });

  it("gives a subtask the message box, which goes to the task's planner", () => {
    const flow = flowWith(
      { composer: 'subtask', parentKey: 'epic-1', entries: [entry('r1', 'planner', 'Use cursors')] },
      { parentKey: 'epic-1', status: 'failed', resume: 'ready', reason: 'the check failed' },
    );
    render(column(flow), { wrapper: Wrapper });

    expect(screen.getByRole('textbox', { name: 'Message to the planner' })).toBeInTheDocument();
    expect(screen.getByText("goes to this task's planner")).toBeInTheDocument();
    expect(screen.queryByText(/is where the planner of this subtask is asked/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Resume' })).toBeEnabled();
    expect(screen.getByText('Use cursors')).toBeInTheDocument();
  });

  it("says a merged subtask's message goes to the epic's planner", () => {
    render(column(flowWith({ composer: 'epic', parentKey: 'epic-1' }, { parentKey: 'epic-1', status: 'done' })), {
      wrapper: Wrapper,
    });
    expect(screen.getByText("goes to the epic's planner")).toBeInTheDocument();
  });

  it('starts a follow-up run from a merged run, with the message and a link to this run', async () => {
    const user = userEvent.setup({ delay: null });
    render(column(flowWith({ composer: 'follow-up' }, { status: 'done' })), { wrapper: Wrapper });

    expect(screen.getByText('starts a follow-up run')).toBeInTheDocument();
    await pasteMessage(user, screen.getByRole('textbox', { name: 'Message to the planner' }), 'also add logging');
    await user.click(screen.getByRole('button', { name: 'Start a follow-up run' }));

    const dialog = await screen.findByRole('dialog');
    const prompt = within(dialog).getByRole('textbox', { name: /message|prompt/i });
    expect(prompt).toHaveValue(`also add logging\n\nFollow-up of run run-1: ${window.location.origin}/runs/run-1`);
    expect(sendPlanChat).not.toHaveBeenCalled();
  });
});

describe('ConversationColumn widening', () => {
  mediaWidth(1280);

  const wideColumn = (onWide: () => void, wide: boolean) => (
    <ConversationColumn flow={flowWith()} onResume={vi.fn()} onChange={vi.fn()} onWide={onWide} wide={wide} />
  );

  it('shows Widen with its icon, then Narrow with its icon, and tells onWide', async () => {
    const user = userEvent.setup({ delay: null });
    const onWide = vi.fn();
    const { rerender } = render(wideColumn(onWide, false), { wrapper: Wrapper });

    const widen = screen.getByRole('button', { name: 'Widen' });
    expect(widen.querySelector('[data-testid="OpenInFullIcon"]')).not.toBeNull();
    await user.click(widen);
    expect(onWide).toHaveBeenLastCalledWith(true);

    rerender(wideColumn(onWide, true));
    const narrow = screen.getByRole('button', { name: 'Narrow' });
    expect(narrow.querySelector('[data-testid="CloseFullscreenIcon"]')).not.toBeNull();
    expect(screen.getByRole('complementary', { name: 'Conversation' })).not.toHaveStyle({ maxWidth: '400px' });
    await user.click(narrow);
    expect(onWide).toHaveBeenLastCalledWith(false);
  });

  it('ends the wide choice when it collapses', async () => {
    const user = userEvent.setup({ delay: null });
    const onWide = vi.fn();
    render(wideColumn(onWide, true), { wrapper: Wrapper });

    await user.click(screen.getByRole('button', { name: 'Collapse the conversation' }));
    expect(onWide).toHaveBeenCalledWith(false);
  });

  it('ends the wide choice when a stored closed state shows the rail', async () => {
    localStorage.setItem('swarmloop.conversation.alice', 'closed');
    const onWide = vi.fn();
    render(wideColumn(onWide, true), { wrapper: Wrapper });

    expect(await screen.findByRole('complementary', { name: 'Conversation rail' })).toBeInTheDocument();
    expect(onWide).toHaveBeenCalledWith(false);
  });

  it('ends the column at the bottom of the window from where its top is, so the message box is in view', () => {
    window.innerHeight = 800;
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 500 } as DOMRect);
    render(column(flowWith()), { wrapper: Wrapper });

    const aside = screen.getByRole('complementary', { name: 'Conversation' });
    expect(aside).toHaveStyle({ height: `${800 - 500 - 16}px` });
    expect(within(aside).getByRole('textbox', { name: 'Message to the planner' })).toBeInTheDocument();
    rect.mockRestore();
  });
});

describe('ConversationColumn on a narrow window', () => {
  mediaWidth(600);

  it('is a bottom sheet with the message box at its bottom, opened from a button', async () => {
    const user = userEvent.setup({ delay: null });
    render(column(flowWith({ entries: [entry('r1', 'planner', 'hello there')] })), { wrapper: Wrapper });

    expect(screen.queryByRole('complementary')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Widen' })).toBeNull();
    expect(screen.queryByText('hello there')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Open the conversation' }));

    const sheet = await screen.findByRole('region', { name: 'Conversation' });
    expect(within(sheet).getByText('hello there')).toBeInTheDocument();
    const box = within(sheet).getByRole('textbox', { name: 'Message to the planner' });
    const feed = within(sheet).getByRole('log', { name: 'Conversation' });
    expect(feed.compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('opens by itself when something needs the person', async () => {
    const flow = flowWith({}, { status: 'failed', resume: 'ready', reason: 'the check failed' });
    render(column(flow), { wrapper: Wrapper });

    const sheet = await screen.findByRole('region', { name: 'Conversation' });
    expect(within(sheet).getByRole('button', { name: 'Resume' })).toBeInTheDocument();
  });
});
