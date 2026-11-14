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
  defaults: { agents: { main: roles, subtask: roles } },
  runtimes: [
    { runtime: 'claude', models: ['opus', 'sonnet'], efforts: { opus: ['low', 'high'], sonnet: [] } },
    { runtime: 'codex', models: ['gpt', 'gpt-priced'], efforts: {} },
  ],
  modelsLimited: false,
  server: [
    { name: 'MAX_RUN_USD', secret: false, source: 'default', value: '5' },
    { name: 'SWARMLOOP_SECRET', secret: true, source: 'default', value: 'set' },
  ],
});
const own = (...entries: [string, string][]): SettingsView['settings'] => ({
  agents: { main: { plan: entries.map(([runtime, model]) => ({ runtime, model })) } },
});
const ownHigh: SettingsView['settings'] = {
  agents: { main: { plan: [{ runtime: 'claude', model: 'opus', effort: 'high' }] } },
};

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

  it('offers a model only the price table has, and says when the list is limited', async () => {
    const user = await openOwnPlan();
    expect(screen.queryByText("The model list is limited to the server's models for now.")).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Add to main plan' }));
    expect(await screen.findByRole('option', { name: 'codex:gpt-priced' })).toBeInTheDocument();

    vi.mocked(getSettings).mockResolvedValue({ ...view(), modelsLimited: true });
    render(<SettingsPage />);
    expect(await screen.findByText("The model list is limited to the server's models for now.")).toBeInTheDocument();
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

  it('offers the levels of the chosen model, with the runtime default first', async () => {
    const user = await openOwnPlan();

    await user.click(screen.getByRole('combobox', { name: 'Effort of claude:opus' }));

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Runtime default',
      'low',
      'high',
    ]);
  });

  it('offers no level for a model that has none', async () => {
    await openOwnPlan(own(['claude', 'sonnet']));

    expect(screen.queryByRole('combobox', { name: /^Effort of/ })).not.toBeInTheDocument();
  });

  it('saves the chosen level', async () => {
    const user = await openOwnPlan();

    await user.click(screen.getByRole('combobox', { name: 'Effort of claude:opus' }));
    await user.click(await screen.findByRole('option', { name: 'high' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSettings).toHaveBeenCalledWith({
      agents: { main: { plan: [{ runtime: 'claude', model: 'opus', effort: 'high' }] } },
    });
  });

  it('saves no level after the runtime default is chosen', async () => {
    const user = await openOwnPlan(ownHigh);

    await user.click(screen.getByRole('combobox', { name: 'Effort of claude:opus:high' }));
    await user.click(await screen.findByRole('option', { name: 'Runtime default' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSettings).toHaveBeenCalledWith({ agents: { main: { plan: [{ runtime: 'claude', model: 'opus' }] } } });
  });

  it('clears a level the new model lacks', async () => {
    const user = await openOwnPlan(ownHigh);

    await user.click(screen.getByRole('combobox', { name: 'Model of claude:opus:high' }));
    await user.click(await screen.findByRole('option', { name: 'sonnet' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSettings).toHaveBeenCalledWith({ agents: { main: { plan: [{ runtime: 'claude', model: 'sonnet' }] } } });
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

  it('renders no SPLIT control and saves no split', async () => {
    const user = userEvent.setup();
    render(<SettingsPage />);

    await screen.findByRole('button', { name: 'Save' });
    expect(screen.queryByText(/SPLIT/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(vi.mocked(saveSettings).mock.lastCall![0]).not.toHaveProperty('split');
  });

  it('shows what a server setting means under its value', async () => {
    const user = userEvent.setup();
    const described = view();
    described.server = [
      {
        name: 'CHECKS_PARALLEL',
        secret: false,
        source: 'default',
        value: '3',
        description: 'Check commands that run at once on the whole server',
      },
    ];
    vi.mocked(getSettings).mockResolvedValue(described);
    render(<SettingsPage />);
    await screen.findByRole('button', { name: 'Save' });

    await user.click(screen.getByRole('button', { name: 'Server' }));

    expect(screen.getByText('Check commands that run at once on the whole server')).toBeInTheDocument();
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

  it('shows where each server setting comes from, secrets included', async () => {
    const user = userEvent.setup();
    const sourced = view();
    sourced.server = [
      { name: 'MAX_RUN_USD', secret: false, source: 'default', value: '5' },
      { name: 'MAX_RETURNS', secret: false, source: '.env', value: '7' },
      { name: 'SWARMLOOP_SECRET', secret: true, source: 'environment', value: 'set' },
    ];
    vi.mocked(getSettings).mockResolvedValue(sourced);
    render(<SettingsPage />);
    await screen.findByRole('button', { name: 'Save' });

    await user.click(screen.getByRole('button', { name: 'Server' }));

    expect(screen.getByText('default')).toBeInTheDocument();
    expect(screen.getByText('.env')).toBeInTheDocument();
    expect(screen.getByText('environment')).toBeInTheDocument();
    expect(screen.getByText('SWARMLOOP_SECRET').nextElementSibling).toHaveTextContent('setenvironment');
  });
});
