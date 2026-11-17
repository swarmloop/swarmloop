import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createTheme, ThemeProvider } from '@mui/material/styles';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession, logout } from '../../lib/endpoints';
import { Account } from './account';

vi.mock('../../lib/endpoints', () => ({ getSession: vi.fn(), logout: vi.fn() }));

const assign = vi.fn();
const theme = createTheme({ cssVariables: true, colorSchemes: { light: true, dark: true } });

function GitHubMark(): React.ReactElement {
  return <svg data-testid="mark-github" />;
}

const hostOf = (): { label: string; Mark: () => React.ReactElement } => ({ label: 'GitHub', Mark: GitHubMark });

function renderAccount(needsAttention = false): void {
  render(
    <ThemeProvider theme={theme}>
      <Account hostOf={hostOf} needsAttention={needsAttention} />
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

  it('still shows the button when the session cannot be read', async () => {
    vi.mocked(getSession).mockRejectedValue(new Error('offline'));

    renderAccount();
    await vi.waitFor(() => expect(getSession).toHaveBeenCalled());

    expect(screen.getByRole('button', { name: /Account/ })).toBeInTheDocument();
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

    expect(screen.getByRole('link', { name: 'swarmloop 1.2.3' })).toHaveAttribute(
      'href',
      `${SOURCE}/releases/tag/v1.2.3`,
    );
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

    expect(screen.getByText('swarmloop 1.2.3')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'swarmloop 1.2.3' })).not.toBeInTheDocument();
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
