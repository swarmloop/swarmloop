import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession, logout } from '../../lib/endpoints';
import { receive, resetFakeSocket } from '../../test/fake-socket';
import { mediaWidth } from '../../test/viewport';
import { Account } from './account';
import { LiveBridgeProvider } from './use-live-bridge';

vi.mock('../../lib/endpoints', () => ({ getSession: vi.fn(), logout: vi.fn() }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

const assign = vi.fn();
const theme = createTheme({ cssVariables: true, colorSchemes: { light: true, dark: true } });

function GitHubMark(): React.ReactElement {
  return <svg data-testid="mark-github" />;
}

const hostOf = (): { label: string; Mark: () => React.ReactElement } => ({ label: 'GitHub', Mark: GitHubMark });

function renderAccount(needsAttention = false): void {
  render(
    <ThemeProvider theme={theme}>
      <LiveBridgeProvider>
        <Account hostOf={hostOf} needsAttention={needsAttention} />
      </LiveBridgeProvider>
    </ThemeProvider>,
  );
}

const SOURCE = 'https://github.com/swarmloop/swarmloop';
const signedIn = { user: 'octocat', provider: 'github', version: '1.2.3', sourceUrl: SOURCE };

async function openMenu(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup({ delay: null });
  await user.click(await screen.findByRole('button', { name: /octocat/ }));
  return user;
}

beforeEach(() => {
  vi.mocked(getSession).mockReset();
  vi.mocked(logout).mockReset().mockResolvedValue({ ok: true });
  assign.mockReset();
  resetFakeSocket();
  vi.stubGlobal('location', { assign });
});

describe('Account', () => {
  it('shows the user and logs out to the login page', async () => {
    vi.mocked(getSession).mockResolvedValue({ user: 'octocat', provider: 'github' });

    renderAccount();
    const user = await openMenu();

    expect(screen.getAllByText('octocat').length).toBeGreaterThan(0);
    expect(screen.getAllByText('GitHub').length).toBeGreaterThan(0);
    await user.click(screen.getByRole('menuitem', { name: 'Log out' }));
    expect(logout).toHaveBeenCalled();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('/login'));
  });

  it('opens Settings and Connections from the menu', async () => {
    vi.mocked(getSession).mockResolvedValue({ user: 'octocat', provider: 'github' });

    renderAccount();
    await openMenu();

    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.getByRole('menuitem', { name: 'Connections' })).toHaveAttribute('href', '/connections');
  });

  it('shows initials when the account has no avatar', async () => {
    vi.mocked(getSession).mockResolvedValue({ user: 'octocat', avatarUrl: null });

    renderAccount();

    expect(await screen.findByText('OC')).toBeInTheDocument();
  });

  it('shows a placeholder, never the word Account, before the first answer', async () => {
    vi.mocked(getSession).mockReturnValue(new Promise(() => undefined));

    renderAccount();

    const trigger = screen.getByRole('button', { name: 'Account menu' });
    expect(within(trigger).queryByText('Account')).not.toBeInTheDocument();
    expect(trigger.querySelectorAll('.MuiSkeleton-circular')).toHaveLength(1);
    expect(trigger.querySelector('.MuiSkeleton-circular')).toHaveStyle({ width: '32px', height: '32px' });
  });

  it('shows the placeholder in the panel too, with the version line', async () => {
    vi.mocked(getSession).mockRejectedValue(new Error('offline'));

    renderAccount();
    await vi.waitFor(() => expect(getSession).toHaveBeenCalled());
    await userEvent.setup({ delay: null }).click(screen.getByRole('button', { name: 'Account menu' }));

    const menu = screen.getByRole('menu', { name: 'Account' });
    expect(screen.getByRole('presentation').querySelector('.MuiSkeleton-circular')).toHaveStyle({ width: '40px' });
    expect(within(menu).getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
    expect(screen.getByText('swarmloop dev')).toBeInTheDocument();
  });

  it('shows the person after the live connect when the first read failed', async () => {
    vi.mocked(getSession).mockRejectedValueOnce(new Error('offline')).mockResolvedValue(signedIn);

    renderAccount();
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(1));
    await act(async () => Promise.resolve());
    expect(screen.queryByText('octocat')).not.toBeInTheDocument();
    expect(screen.queryByText('Account')).not.toBeInTheDocument();

    act(() => receive('connect'));

    expect(await screen.findByRole('button', { name: /octocat/ })).toBeInTheDocument();
    expect(getSession).toHaveBeenCalledTimes(2);
  });

  it('does not read again on the first connect when the first read worked', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    await screen.findByRole('button', { name: /octocat/ });
    act(() => receive('connect'));
    await act(async () => Promise.resolve());

    expect(getSession).toHaveBeenCalledTimes(1);
  });

  it('reads the person again on a connect that follows an earlier one', async () => {
    vi.mocked(getSession)
      .mockResolvedValueOnce(signedIn)
      .mockResolvedValue({ ...signedIn, user: 'hubot' });

    renderAccount();
    await screen.findByRole('button', { name: /octocat/ });
    act(() => receive('connect'));
    act(() => receive('connect'));

    expect(await screen.findByRole('button', { name: /hubot/ })).toBeInTheDocument();
  });

  it('keeps the person shown when a later read fails', async () => {
    vi.mocked(getSession).mockResolvedValueOnce(signedIn).mockRejectedValue(new Error('restarting'));

    renderAccount();
    await screen.findByRole('button', { name: /octocat/ });
    act(() => receive('connect'));
    act(() => receive('connect'));
    await vi.waitFor(() => expect(getSession).toHaveBeenCalledTimes(2));
    await act(async () => Promise.resolve());

    expect(screen.getByRole('button', { name: /octocat/ })).toBeInTheDocument();
    expect(screen.queryByText('Account')).not.toBeInTheDocument();
  });

  it('falls back to the initials when the photo does not load', async () => {
    vi.stubGlobal(
      'Image',
      class {
        onerror: (() => void) | null = null;
        set src(_: string) {
          queueMicrotask(() => this.onerror?.());
        }
      },
    );
    vi.mocked(getSession).mockResolvedValue({ ...signedIn, avatarUrl: 'https://avatars.test/octocat.png' });

    renderAccount();
    const trigger = await screen.findByRole('button', { name: /octocat/ });

    expect(await within(trigger).findByText('OC')).toBeInTheDocument();
    expect(trigger.querySelector('img')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('the trigger shows the avatar, the login and GitHub with its mark', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    const trigger = await screen.findByRole('button', { name: /octocat/ });

    expect(within(trigger).getByText('OC')).toBeInTheDocument();
    expect(within(trigger).getByText('GitHub')).toBeInTheDocument();
    expect(within(trigger).getByTestId('mark-github')).toBeInTheDocument();
  });

  it('a session without a provider shows no host line', async () => {
    vi.mocked(getSession).mockResolvedValue({ user: 'octocat' });

    renderAccount();
    const user = await openMenu();

    expect(screen.queryByText('GitHub')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mark-github')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
  });

  it('Enter on the trigger opens the panel with the first item focused', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    const trigger = await screen.findByRole('button', { name: /octocat/ });
    trigger.focus();
    await userEvent.setup({ delay: null }).keyboard('{Enter}');

    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });

  it('the open panel shows the header, the items with their icons and the theme parts', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    await openMenu();

    const menu = screen.getByRole('menu', { name: 'Account' });
    expect(screen.getByText('GitHub · signed in')).toBeInTheDocument();
    for (const name of ['Settings', 'Connections', 'Documentation', 'Log out']) {
      const item = within(menu).getByRole('menuitem', { name });
      expect(item.querySelector('svg')).not.toBeNull();
    }
    expect(within(menu).getByRole('menuitem', { name: 'Documentation' })).toHaveAttribute('href', `${SOURCE}#readme`);
    for (const name of ['Light', 'System', 'Dark']) {
      expect(within(menu).getByRole('menuitemradio', { name })).toBeInTheDocument();
    }
  });

  it('the theme parts name the chosen one and a click chooses another', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    const user = await openMenu();
    await user.click(screen.getByRole('menuitemradio', { name: 'Dark' }));

    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveAttribute('aria-checked', 'false');
  });

  it('the version links to the release notes', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    await openMenu();

    expect(screen.getByRole('link', { name: 'swarmloop v1.2.3' })).toHaveAttribute(
      'href',
      `${SOURCE}/releases/tag/v1.2.3`,
    );
  });

  it('a source build names its release and its commit, and only the release links to its notes', async () => {
    vi.mocked(getSession).mockResolvedValue({ ...signedIn, version: '0.3.2', revision: 'ae0a069' });

    renderAccount();
    await openMenu();

    const notes = screen.getByRole('link', { name: 'v0.3.2' });
    expect(notes.parentElement).toHaveTextContent('swarmloop v0.3.2 · ae0a069');
    expect(notes).toHaveAttribute('href', `${SOURCE}/releases/tag/v0.3.2`);
    expect(screen.queryByRole('link', { name: /ae0a069/ })).not.toBeInTheDocument();
  });

  it('a source build without a source URL shows the release and the commit as plain text', async () => {
    vi.mocked(getSession).mockResolvedValue({ ...signedIn, version: '0.3.2', revision: 'ae0a069', sourceUrl: null });

    renderAccount();
    await openMenu();

    expect(screen.getByText('swarmloop v0.3.2 · ae0a069')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'v0.3.2' })).not.toBeInTheDocument();
  });

  it('a release reads swarmloop v0.4.0', async () => {
    vi.mocked(getSession).mockResolvedValue({ ...signedIn, version: '0.4.0' });

    renderAccount();
    await openMenu();

    expect(screen.getByRole('link', { name: 'swarmloop v0.4.0' })).toBeInTheDocument();
  });

  it('a version that is not a release links to the releases page', async () => {
    vi.mocked(getSession).mockResolvedValue({ ...signedIn, version: 'dev' });

    renderAccount();
    await openMenu();

    expect(screen.getByRole('link', { name: 'swarmloop dev' })).toHaveAttribute('href', `${SOURCE}/releases`);
  });

  it('without a source URL the version is plain text and Documentation is absent', async () => {
    vi.mocked(getSession).mockResolvedValue({ user: 'octocat', provider: 'github', version: '1.2.3', sourceUrl: null });

    renderAccount();
    await openMenu();

    expect(screen.getByText('swarmloop v1.2.3')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'swarmloop v1.2.3' })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Documentation' })).not.toBeInTheDocument();
  });

  it('with needsAttention Connections shows the dot and Needs attention', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount(true);
    await openMenu();

    expect(screen.getByRole('menuitem', { name: 'Connections' })).toHaveTextContent('Needs attention');
  });

  it('without needsAttention Connections shows no hint', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount(false);
    await openMenu();

    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
  });

  it('arrow keys move focus through the items and into the theme parts', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    const user = await openMenu();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Connections' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitemradio', { name: 'Light' })).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('menuitemradio', { name: 'System' })).toHaveFocus();
    await user.keyboard('{ArrowLeft}{ArrowLeft}');
    expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitemradio', { name: 'System' })).toHaveFocus();
  });

  it('Home and End go to the first and last item and the arrows wrap', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    const user = await openMenu();

    await user.keyboard('{End}');
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(screen.getByRole('menuitem', { name: 'Settings' })).toHaveFocus();
  });

  it('Escape closes the panel and focus returns to the trigger', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    const user = await openMenu();
    await user.keyboard('{Escape}');

    await vi.waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: /octocat/ })).toHaveFocus();
  });
});

describe('Account at 375 px', () => {
  mediaWidth(375);

  it('opens the menu as a bottom sheet with the version line and closes it on picking an item', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    const user = await openMenu();

    expect(document.querySelector('.MuiDrawer-paperAnchorBottom')).not.toBeNull();
    expect(document.querySelector('.MuiPopover-paper')).toBeNull();
    expect(screen.getByRole('link', { name: /1\.2\.3/ })).toBeInTheDocument();
    await user.click(screen.getByRole('menuitem', { name: 'Settings' }));
    await vi.waitFor(() => expect(screen.queryByRole('menu', { name: 'Account' })).not.toBeInTheDocument());
  });

  it('gives the items and the theme parts a 40 px touch target and closes the sheet on Documentation', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    const user = await openMenu();

    const menu = screen.getByRole('menu', { name: 'Account' });
    for (const name of ['Settings', 'Connections', 'Documentation', 'Log out']) {
      expect(within(menu).getByRole('menuitem', { name })).toHaveStyle({ height: '40px' });
    }
    for (const name of ['Light', 'System', 'Dark']) {
      expect(within(menu).getByRole('menuitemradio', { name })).toHaveStyle({ width: '40px', height: '40px' });
    }
    await user.click(within(menu).getByRole('menuitem', { name: 'Documentation' }));
    await vi.waitFor(() => expect(screen.queryByRole('menu', { name: 'Account' })).not.toBeInTheDocument());
  });
});

describe('Account at 1280 px', () => {
  mediaWidth(1280);

  it('stays a popover with the version line', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    await openMenu();

    expect(document.querySelector('.MuiPopover-paper')).not.toBeNull();
    expect(document.querySelector('.MuiDrawer-paperAnchorBottom')).toBeNull();
    expect(screen.getByRole('link', { name: /1\.2\.3/ })).toBeInTheDocument();
  });

  it('keeps the compact items and leaves the popover open on Documentation', async () => {
    vi.mocked(getSession).mockResolvedValue(signedIn);

    renderAccount();
    const user = await openMenu();

    const menu = screen.getByRole('menu', { name: 'Account' });
    expect(within(menu).getByRole('menuitem', { name: 'Settings' })).toHaveStyle({ height: '36px' });
    expect(within(menu).getByRole('menuitemradio', { name: 'Dark' })).toHaveStyle({ width: '28px', height: '24px' });
    await user.click(within(menu).getByRole('menuitem', { name: 'Documentation' }));
    expect(screen.getByRole('menu', { name: 'Account' })).toBeInTheDocument();
  });
});
