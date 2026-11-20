import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BacklogView } from '@contract/backlog';
import type { BacklogChatView } from '@contract/backlog-chat';
import { resumeBacklogTurn, runBacklog, runMilestone, sendBacklogMessage } from '../../../lib/backlog-endpoints';
import { uploadFile } from '../../../lib/endpoints';
import {
  backlogChatView,
  backlogView,
  chatMessage,
  milestone,
  requirement,
  task,
} from '../../../test/backlog-fixtures';
import { BacklogChat } from './backlog-chat';

vi.mock('../../../lib/backlog-endpoints', () => ({
  sendBacklogMessage: vi.fn(),
  resumeBacklogTurn: vi.fn(),
  runMilestone: vi.fn(),
  runBacklog: vi.fn(),
}));
vi.mock('../../../lib/endpoints', () => ({ uploadFile: vi.fn() }));

const onView = vi.fn();
const onChat = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(uploadFile).mockImplementation((_file, name) => Promise.resolve({ id: `id-${name}`, name, size: 3 }));
});

function show(chat: BacklogChatView, view: BacklogView = backlogView(), login: string | null = 'ada'): void {
  render(<BacklogChat view={view} chat={chat} login={login} onView={onView} onChat={onChat} />);
}

/** A backlog that proposes M4 and M5, each with a planner message that offers it. */
function proposals(): { view: BacklogView; chat: BacklogChatView } {
  const view = backlogView({
    milestones: [
      milestone({ number: 4, title: 'Refunds', goal: 'A shopper can get money back', status: 'proposed' }),
      milestone({ number: 5, title: 'Gifts', goal: 'A shopper can send a gift', status: 'proposed' }),
    ],
    requirements: [
      requirement({ ref: 'M4.R1', milestone: 4, text: 'A refund returns the money' }),
      requirement({ ref: 'M5.R1', milestone: 5, text: 'A gift has a card' }),
    ],
    tasks: [task({ slug: 'refund-form', title: 'Refund form', milestone: 4 })],
  });
  const chat = backlogChatView({
    messages: [
      chatMessage({
        id: 1,
        author: 'planner',
        text: 'Here is M4.',
        proposes: 4,
        createdAt: '2026-01-01T10:00:00.000Z',
      }),
      chatMessage({ id: 2, author: 'planner', text: 'And M5.', proposes: 5, createdAt: '2026-01-01T10:01:00.000Z' }),
    ],
  });
  return { view, chat };
}

describe('BacklogChat proposals', () => {
  it('shows the first proposed milestone as a question with both actions, each one click', async () => {
    const user = userEvent.setup({ delay: null });
    const { view, chat } = proposals();
    vi.mocked(runMilestone).mockResolvedValue(view);
    vi.mocked(runBacklog).mockResolvedValue(view);
    show(chat, view);

    expect(screen.getAllByText('Question for you')).toHaveLength(2);
    expect(screen.getByText('A shopper can get money back')).toBeInTheDocument();
    expect(screen.getByText('A refund returns the money')).toBeInTheDocument();
    expect(screen.getByText('Refund form')).toBeInTheDocument();
    const buttons = screen.getAllByRole('button', { name: /Run (milestone|backlog)/ });
    expect(buttons.map((button) => button.textContent)).toEqual(['Run milestone', 'Run backlog', 'Run milestone']);

    await user.click(buttons[0]);
    await user.click(buttons[1]);

    expect(runMilestone).toHaveBeenCalledWith('swarmloop', 4);
    expect(runBacklog).toHaveBeenCalledWith('swarmloop');
    await waitFor(() => expect(onView).toHaveBeenCalledTimes(2));
  });

  it('offers only Run milestone under a later proposal, and nothing to anyone but the owner', () => {
    const { view, chat } = proposals();
    show(chat, view, 'bob');

    expect(screen.queryByRole('button', { name: /Run / })).not.toBeInTheDocument();
  });

  it('shows a refusal of Run milestone as an alert', async () => {
    const user = userEvent.setup({ delay: null });
    const { view, chat } = proposals();
    vi.mocked(runMilestone).mockRejectedValue(new Error('Another milestone is active'));
    show(chat, view);

    await user.click(screen.getAllByRole('button', { name: 'Run milestone' })[0]);

    expect(await screen.findByRole('alert')).toHaveTextContent('Another milestone is active');
  });
});

describe('BacklogChat turns and lines', () => {
  it('shows a failed turn as a card whose Resume resumes it', async () => {
    const user = userEvent.setup({ delay: null });
    const next = backlogChatView({ turns: [{ status: 'running', reason: '', nextTryAt: null }] });
    vi.mocked(resumeBacklogTurn).mockResolvedValue(next);
    show(backlogChatView({ turns: [{ status: 'failed', reason: 'The model refused', nextTryAt: null }] }));

    expect(screen.getByRole('region', { name: 'Problem' })).toHaveTextContent('The model refused');
    await user.click(screen.getByRole('button', { name: 'Resume' }));

    expect(resumeBacklogTurn).toHaveBeenCalledWith('swarmloop');
    await waitFor(() => expect(onChat).toHaveBeenCalledWith(next));
  });

  it('shows the next try of a waiting turn in local time, without an ISO time', () => {
    const at = '2026-01-01T10:30:00.000Z';
    show(backlogChatView({ turns: [{ status: 'waiting', reason: 'The usage limit is reached.', nextTryAt: at }] }));

    const local = new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' }).format(new Date(at));
    expect(screen.getByText(`The usage limit is reached. The planner tries again at ${local}.`)).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(/\d{4}-\d{2}-\d{2}T/);
  });

  it('shows info and refused messages and a by-hand action as info lines, and no JSON', () => {
    const view = backlogView({
      events: [
        {
          kind: 'action',
          facts: { action: 'skip task', who: 'ada', task: 'pay-by-card' },
          at: '2026-01-01T10:02:00.000Z',
        },
      ],
    });
    show(
      backlogChatView({
        messages: [
          chatMessage({
            id: 1,
            author: 'planner',
            kind: 'info',
            text: 'Run 7 asked for you.',
            createdAt: '2026-01-01T10:00:00.000Z',
          }),
          chatMessage({
            id: 2,
            author: 'planner',
            kind: 'refused',
            text: 'I dropped a task.',
            createdAt: '2026-01-01T10:01:00.000Z',
          }),
        ],
      }),
      view,
    );

    const log = screen.getByRole('log');
    expect(within(log).getByText('Run 7 asked for you.')).toBeInTheDocument();
    expect(within(log).getByText('I dropped a task.')).toBeInTheDocument();
    expect(within(log).getByText('ada skipped “Pay by card”.')).toBeInTheDocument();
    expect(log).not.toHaveTextContent(/[{}]|"facts"|pay-by-card/);
  });

  it('shows one quiet line while the planner works, in a slot that is there when it does not', () => {
    const slot = (): HTMLElement =>
      screen.getByRole('region', { name: 'Chat' }).querySelector('[data-slot="quiet"]') as HTMLElement;
    const { rerender } = render(
      <BacklogChat view={backlogView()} chat={backlogChatView()} login="ada" onView={onView} onChat={onChat} />,
    );
    const idle = slot();
    expect(idle).toBeEmptyDOMElement();

    rerender(
      <BacklogChat
        view={backlogView()}
        chat={backlogChatView({ turns: [{ status: 'running', reason: '', nextTryAt: null }] })}
        login="ada"
        onView={onView}
        onChat={onChat}
      />,
    );

    expect(screen.getAllByText('The planner is working on your messages…')).toHaveLength(1);
    expect(slot()).toBe(idle);
    expect(slot()).toHaveStyle({ height: '24px' });
  });
});

describe('BacklogChat message box', () => {
  it('sends a message with its file id, clears the box and shows the file name', async () => {
    const user = userEvent.setup({ delay: null });
    const sent = backlogChatView({
      messages: [chatMessage({ text: 'See the file', attachments: [{ id: 'id-a.txt', name: 'a.txt', size: 3 }] })],
    });
    vi.mocked(sendBacklogMessage).mockResolvedValue(sent);
    const view = backlogView();
    const { rerender } = render(
      <BacklogChat view={view} chat={backlogChatView({ messages: [] })} login="ada" onView={onView} onChat={onChat} />,
    );
    const box = screen.getByRole('textbox', { name: 'Message to the planner' });
    await user.type(box, 'See the file');
    fireEvent.drop(box, { dataTransfer: { files: [new File(['abc'], 'a.txt')] } });
    await screen.findByText('a.txt');

    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onChat).toHaveBeenCalledWith(sent));
    expect(sendBacklogMessage).toHaveBeenCalledWith('swarmloop', 'See the file', ['id-a.txt'], expect.any(String));
    expect(screen.getByRole('textbox', { name: 'Message to the planner' })).toHaveValue('');
    expect(screen.queryByText('a.txt')).not.toBeInTheDocument();

    rerender(<BacklogChat view={view} chat={sent} login="ada" onView={onView} onChat={onChat} />);
    expect(screen.getByText('Files: a.txt')).toBeInTheDocument();
  });

  it('tells someone other than the owner who writes, and shows no message box', () => {
    show(backlogChatView(), backlogView(), 'bob');

    expect(screen.getByText('Only ada writes to this planner.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});
