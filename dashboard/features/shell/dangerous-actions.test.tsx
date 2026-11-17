import type { ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ConnectionsView } from '@contract/api';
// eslint-disable-next-line no-restricted-imports -- a whole-screen test: the app shell owns the Remove run confirm
import { DashboardShell } from '../../app/dashboard-shell';
import {
  disconnect,
  disconnectIntegration,
  getConnections,
  getFlow,
  getIntegrationCards,
  getOwner,
  getSession,
  getStep,
  getStepEvents,
  listProjects,
  listRemote,
  listRuns,
  rebaseRun,
  removeRun,
  replaceApp,
  replayStep,
  resumeRun,
  startReviewer,
  skipTask,
  stopRun,
  ticketKeys,
} from '../../lib/endpoints';
import { receive } from '../../test/fake-socket';
import { QueryWrapper } from '../../test/query-wrapper';
import { connectionCard, flowView, runSummary, stepView } from '../../test/fixtures';
import { ConnectionsPage } from '../connections';
import { RunScreen } from '../run';
import { LiveBridgeProvider } from './use-live-bridge';

vi.mock('next/navigation', () => ({ usePathname: vi.fn(), useRouter: vi.fn(), useSearchParams: vi.fn() }));
vi.mock('../../lib/endpoints', () => ({
  getFlow: vi.fn(),
  getStep: vi.fn(),
  getStepEvents: vi.fn(),
  getRunLog: vi.fn(),
  listProjects: vi.fn(),
  listRemote: vi.fn(),
  listRuns: vi.fn(),
  createRun: vi.fn(),
  setRunProjects: vi.fn(),
  sendAnswers: vi.fn(),
  resumeRun: vi.fn(),
  stopRun: vi.fn(),
  rebaseRun: vi.fn(),
  skipTask: vi.fn(),
  startReviewer: vi.fn(),
  replayStep: vi.fn(),
  ticketKeys: vi.fn(),
  removeRun: vi.fn(),
  getSession: vi.fn(),
  logout: vi.fn(),
  getConnections: vi.fn(),
  getIntegrationCards: vi.fn(),
  getOwner: vi.fn(),
  disconnect: vi.fn(),
  disconnectIntegration: vi.fn(),
  replaceApp: vi.fn(),
  installMore: vi.fn(),
  reconnectUrl: (host: string) => `/auth/${host}/login`,
}));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

/** Dialogs open and close at once, so no test waits on a transition. */
const theme = createTheme({ components: { MuiDialog: { defaultProps: { transitionDuration: 0 } } } });

function Themed({ children }: { children: ReactNode }) {
  return <ThemeProvider theme={theme}>{children}</ThemeProvider>;
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <Themed>
      <QueryWrapper>
        <LiveBridgeProvider>{children}</LiveBridgeProvider>
      </QueryWrapper>
    </Themed>
  );
}

const tasks = [
  { id: 'a', index: 0, title: 'Add the column', files: [], proof: 'a', depends: [], status: 'merged' as const },
  { id: 'b', index: 1, title: 'Send it', files: [], proof: 'b', depends: [], status: 'blocked' as const },
  { id: 'c', index: 2, title: 'Show it', files: [], proof: 'c', depends: ['b'], status: 'waiting' as const },
];

const host: ConnectionsView = {
  connections: [
    {
      host: 'github',
      appLabel: 'App',
      installs: true,
      app: { name: 'swarmloop-app', clientId: 'Iv.fake', madeBy: 'alice', settingsUrl: null },
      missingOwners: [],
      mayReplace: true,
      account: 'alice',
      repositories: ['alice/site'],
      selection: 'selected',
      health: { status: 'ok', expiresAt: '2026-11-08T21:50:00.000Z', refreshedAt: '2026-11-08T13:50:00.000Z' },
    },
  ],
};

/** One dangerous action: how to reach its button, what the dialog says and which endpoint it sends. */
interface Action {
  name: string;
  open: (user: UserEvent) => Promise<void>;
  title: string;
  verb: string;
  sent: Mock;
  body?: string;
}

/** The confirm is gone; the instructions form of Replay may come back behind it. */
const waitClosed = (title: string): Promise<void> =>
  waitFor(() => expect(screen.queryByRole('heading', { name: title })).toBeNull());

async function runScreen(overrides: Parameters<typeof flowView>[0]): Promise<void> {
  vi.mocked(getFlow).mockResolvedValue(flowView(overrides));
  render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });
  await screen.findByRole('heading', { name: 'Run one' });
}

/** Replay asks for its instructions first and its confirm after them; the form comes back when the confirm is cancelled. */
async function openReplay(user: UserEvent, elsewhere: boolean): Promise<void> {
  if (!screen.queryByLabelText(/Prompt/)) {
    await user.click(await screen.findByRole('button', { name: /^implement/ }));
    await user.click(await screen.findByRole('button', { name: 'Run again' }));
    await user.type(await screen.findByLabelText(/Prompt/), 'Try again');
  }
  if (elsewhere) {
    act(() => receive('flow', flowView({ status: 'running', currentStep: 'plan' })));
  }
  await user.click(await screen.findByRole('button', { name: 'Start' }));
}

const actions: Action[] = [
  {
    name: 'Stop',
    title: 'Stop run-1?',
    verb: 'Stop',
    sent: stopRun as Mock,
    open: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Stop' }));
    },
  },
  {
    name: 'Rebase',
    title: 'Rebase run-1 onto its base branch?',
    verb: 'Rebase',
    sent: rebaseRun as Mock,
    open: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Rebase' }));
    },
  },
  {
    name: 'Skip task',
    title: 'Skip task b?',
    verb: 'Skip task',
    body: 'Show it go on as if it were merged',
    sent: skipTask as Mock,
    open: async (user) => {
      const region = await screen.findByRole('region', { name: 'Tasks' });
      await user.click(within(region).getByRole('button', { name: 'Skip task' }));
    },
  },
  {
    name: 'Replay',
    title: 'Replay from implement?',
    verb: 'Replay',
    sent: replayStep as Mock,
    body: 'Everything after implement is done again',
    open: (user) => openReplay(user, false),
  },
  {
    name: 'Stop and start',
    title: 'Stop plan?',
    verb: 'Stop and start',
    sent: replayStep as Mock,
    body: 'plan is running and stops now, then implement starts again',
    open: (user) => openReplay(user, true),
  },
  {
    name: 'Run again (reviewer)',
    title: 'Run quality again?',
    verb: 'Run again',
    sent: startReviewer as Mock,
    body: 'The quality review runs again',
    open: async (user) => {
      await user.click(await screen.findByRole('button', { name: /^quality/ }));
      await user.click(await screen.findByRole('button', { name: 'Run again' }));
    },
  },
  {
    name: 'Remove run',
    title: 'Remove run Run one?',
    verb: 'Remove run',
    sent: removeRun as Mock,
    open: async (user) => {
      fireEvent.mouseEnter(await screen.findByText('Run one'));
      await user.click(await screen.findByRole('button', { name: 'Remove Run one' }));
    },
  },
  {
    name: 'Disconnect (host card)',
    title: 'Disconnect GitHub?',
    verb: 'Disconnect',
    sent: disconnect as Mock,
    open: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    },
  },
  {
    name: 'Disconnect (integration card)',
    title: 'Disconnect Claude?',
    verb: 'Disconnect',
    sent: disconnectIntegration as Mock,
    open: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Disconnect' }));
    },
  },
  {
    name: 'Replace app',
    title: 'Replace swarmloop-app?',
    verb: 'Replace app',
    sent: replaceApp as Mock,
    open: async (user) => {
      await user.click(await screen.findByRole('button', { name: 'Replace app' }));
    },
  },
];

function mount(name: string): void {
  if (name === 'Remove run') {
    render(
      <DashboardShell>
        <p>page</p>
      </DashboardShell>,
      { wrapper: Themed },
    );
  } else if (['Stop', 'Rebase', 'Skip task', 'Replay', 'Stop and start', 'Run again (reviewer)'].includes(name)) {
    render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });
  } else {
    render(<ConnectionsPage />, { wrapper: Themed });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
  vi.mocked(ticketKeys).mockResolvedValue({ keys: [] });
  vi.mocked(getStepEvents).mockResolvedValue({ events: [], next: null });
  vi.mocked(getStep).mockResolvedValue(stepView());
  vi.mocked(listProjects).mockResolvedValue({ projects: [] });
  vi.mocked(listRemote).mockResolvedValue({ repositories: [], owners: [], reason: null, allowedNames: [] });
  vi.mocked(listRuns).mockResolvedValue({ runs: [runSummary()] });
  vi.mocked(getSession).mockResolvedValue({ user: 'alice' });
  vi.mocked(getOwner).mockResolvedValue({ owner: 'acme', others: [] });
  vi.mocked(getConnections).mockResolvedValue(host);
  vi.mocked(getIntegrationCards).mockResolvedValue({
    cards: [connectionCard({ id: 'github', logo: 'github', label: 'GitHub' }), connectionCard()],
  });
  vi.mocked(usePathname).mockReturnValue('/');
  vi.mocked(useSearchParams).mockReturnValue(new URLSearchParams() as unknown as ReturnType<typeof useSearchParams>);
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn(), replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
  for (const send of [stopRun, rebaseRun, skipTask, removeRun, disconnect, disconnectIntegration, resumeRun]) {
    vi.mocked(send).mockResolvedValue({});
  }
  vi.mocked(replaceApp).mockResolvedValue({ action: 'https://github.com/settings/apps/new', manifest: {} });
});

function prepare(name: string): void {
  if (name === 'Stop') {
    vi.mocked(getFlow).mockResolvedValue(flowView({ status: 'running' }));
  } else if (name === 'Rebase') {
    vi.mocked(getFlow).mockResolvedValue(flowView({ status: 'done' }));
  } else if (['Replay', 'Stop and start'].includes(name)) {
    vi.mocked(getFlow).mockResolvedValue(flowView({ status: 'done' }));
    vi.mocked(replayStep).mockResolvedValue({});
  } else if (name === 'Run again (reviewer)') {
    const review = [
      { phase: 'code-review', steps: [{ name: 'code-review', status: 'done', current: false, attempts: 1 }] },
    ];
    vi.mocked(getFlow).mockResolvedValue(flowView({ status: 'done', phases: review }));
    vi.mocked(startReviewer).mockResolvedValue({});
  } else if (name === 'Skip task') {
    vi.mocked(getFlow).mockResolvedValue(flowView({ tasks, status: 'running' }));
  } else if (name === 'Disconnect (integration card)') {
    vi.mocked(getConnections).mockResolvedValue({ connections: [] });
    vi.mocked(getIntegrationCards).mockResolvedValue({
      cards: [connectionCard({ status: 'connected', account: 'alice@acme.test' })],
    });
  } else if (name === 'Disconnect (host card)') {
    vi.mocked(getIntegrationCards).mockResolvedValue({
      cards: [connectionCard({ id: 'github', logo: 'github', label: 'GitHub' })],
    });
  }
}

describe('dangerous actions', () => {
  it.each(actions)('$name asks in the one ConfirmDialog and sends only on its verb', async (action) => {
    const user = userEvent.setup({ delay: null });
    prepare(action.name);
    mount(action.name);

    for (const leave of ['Enter', 'Escape', 'Cancel']) {
      await action.open(user);
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('heading', { name: action.title })).toBeInTheDocument();
      if (action.body) {
        expect(dialog).toHaveTextContent(action.body);
      }
      expect(dialog).toHaveStyle({ width: '440px' });
      expect(
        within(dialog)
          .getAllByRole('button')
          .map((button) => button.textContent),
      ).toEqual(['Cancel', action.verb]);
      expect(within(dialog).getByRole('button', { name: action.verb })).toHaveClass('MuiButton-containedError');
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
      expect(action.sent).not.toHaveBeenCalled();

      if (leave === 'Cancel') {
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      } else {
        await user.keyboard(`{${leave}}`);
      }
      await waitClosed(action.title);
      expect(action.sent).not.toHaveBeenCalled();
    }

    action.sent.mockRejectedValueOnce(new Error('the host refused'));
    await action.open(user);
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: action.verb }));

    const open = await screen.findByRole('dialog');
    expect(await within(open).findByText('the host refused')).toBeInTheDocument();
    expect(within(open).getByRole('button', { name: action.verb })).toBeEnabled();

    await user.click(within(open).getByRole('button', { name: action.verb }));

    await waitClosed(action.title);
    expect(action.sent).toHaveBeenCalledTimes(2);
  });

  it('asks no confirm of its own on Run again of a step: the instructions form comes first, the Replay confirm after it', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(getFlow).mockResolvedValue(flowView({ status: 'done' }));
    render(<RunScreen runKey="run-1" />, { wrapper: Wrapper });

    await user.click(await screen.findByRole('button', { name: /^implement/ }));
    await user.click(await screen.findByRole('button', { name: 'Run again' }));

    expect(await screen.findByLabelText(/Prompt/)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /^Replay from|^Run implement again/ })).toBeNull();
  });

  it('sends Resume at once, with no confirm', async () => {
    const user = userEvent.setup({ delay: null });
    await runScreen({ status: 'failed', state: 'failed', resume: 'ready' });

    await user.click((await screen.findAllByRole('button', { name: 'Resume' }))[0]);

    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(resumeRun).toHaveBeenCalledTimes(1));
  });
});
