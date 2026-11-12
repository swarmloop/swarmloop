import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsView } from '@contract/settings';
import { ApiError } from '../../lib/api';
import { getSettings, saveSettings } from '../../lib/endpoints';
import { SettingsPage } from './settings-page';

vi.mock('../../lib/endpoints', () => ({ getSettings: vi.fn(), saveSettings: vi.fn() }));
vi.mock('../connections', () => ({ ConnectionsPage: () => <p>connections page</p> }));
vi.mock('../shell', () => ({ ThemeModeSwitch: () => <p>theme switch</p> }));

const roles = { plan: ['claude:opus'], implement: ['claude:sonnet'], review: ['claude:sonnet'] };
const view = (settings: SettingsView['settings'] = {}): SettingsView => ({
  settings,
  defaults: { agents: { main: roles, subtask: roles }, split: true },
  runtimes: [
    { runtime: 'claude', models: ['opus', 'sonnet'] },
    { runtime: 'codex', models: ['gpt'] },
  ],
  server: [
    { name: 'MAX_RUN_USD', secret: false, value: '5' },
    { name: 'SWARMLOOP_SECRET', secret: true, value: 'set' },
  ],
});
const own = (...entries: [string, string][]): SettingsView['settings'] => ({
  agents: { main: { plan: entries.map(([runtime, model]) => ({ runtime, model })) } },
});

beforeEach(() => {
  vi.mocked(getSettings).mockReset().mockResolvedValue(view());
  vi.mocked(saveSettings)
    .mockReset()
    .mockImplementation((body) => Promise.resolve(view(body)));
});

const planItems = (): string[] =>
  within(screen.getByRole('list', { name: 'main plan' }))
    .getAllByRole('listitem')
    .map((item) => (item.getAttribute('aria-label') ?? '').split(',')[0]);

async function openOwnPlan(settings = own(['claude', 'opus'])): Promise<ReturnType<typeof userEvent.setup>> {
  vi.mocked(getSettings).mockResolvedValue(view(settings));
  const user = userEvent.setup();
  render(<SettingsPage />);
  await screen.findByRole('list', { name: 'main plan' });
  return user;
}

describe('SettingsPage', () => {
  it('shows the env list read-only and saves nothing for a role on the server default', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    expect(await screen.findAllByLabelText('Server default for main plan')).toHaveLength(1);
    expect(screen.getByLabelText('Server default for main plan')).toHaveTextContent('claude:opus');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSettings).toHaveBeenCalledWith({});
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('adds a connected runtime and model, then saves', async () => {
    const user = await openOwnPlan();

    await user.click(screen.getByRole('combobox', { name: 'Add to main plan' }));
    await user.click(await screen.findByRole('option', { name: 'codex:gpt' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSettings).toHaveBeenCalledWith({
      agents: {
        main: {
          plan: [
            { runtime: 'claude', model: 'opus' },
            { runtime: 'codex', model: 'gpt' },
          ],
        },
      },
    });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('reorders by drag', async () => {
    await openOwnPlan(own(['claude', 'opus'], ['codex', 'gpt']));
    const [first, second] = screen.getAllByRole('listitem');

    fireEvent.dragStart(first);
    fireEvent.drop(second);

    expect(planItems()).toEqual(['codex:gpt', 'claude:opus']);
  });

  it('reorders with the arrow keys', async () => {
    await openOwnPlan(own(['claude', 'opus'], ['codex', 'gpt']));

    fireEvent.keyDown(screen.getAllByRole('listitem')[1], { key: 'ArrowUp' });

    expect(planItems()).toEqual(['codex:gpt', 'claude:opus']);
  });

  it('removes an entry', async () => {
    const user = await openOwnPlan(own(['claude', 'opus'], ['codex', 'gpt']));

    await user.click(screen.getByRole('button', { name: 'Remove claude:opus' }));

    expect(planItems()).toEqual(['codex:gpt']);
  });

  it('shows the reason of a refused choice and does not say Saved', async () => {
    vi.mocked(saveSettings).mockRejectedValue(new ApiError(400, 'agent codex:gpt of plan has no credential'));
    const user = await openOwnPlan();

    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText('agent codex:gpt of plan has no credential')).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('saves a SPLIT override and goes back to the server default when it is cleared', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await user.click(await screen.findByRole('switch', { name: 'Use server default for SPLIT' }));
    await user.click(screen.getByRole('button', { name: 'off' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveSettings).toHaveBeenLastCalledWith(expect.objectContaining({ split: false }));

    await user.click(screen.getByRole('switch', { name: 'Use server default for SPLIT' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(vi.mocked(saveSettings).mock.lastCall![0]).not.toHaveProperty('split');
  });

  it('switches sections and shows secrets as set', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);
    await screen.findByRole('button', { name: 'Save' });

    await user.click(screen.getByRole('button', { name: 'Connections' }));
    expect(screen.getByText('connections page')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Appearance' }));
    expect(screen.getByText('theme switch')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Server' }));
    expect(screen.getByText('MAX_RUN_USD')).toBeInTheDocument();
    expect(screen.getByText('set')).toBeInTheDocument();
  });
});
