import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SettingsView } from '@contract/settings';
import { ApiError } from '../../lib/api';
import { getSettings, saveSettings } from '../../lib/endpoints';
import { SettingsPage } from './settings-page';

vi.mock('../../lib/endpoints', () => ({ getSettings: vi.fn(), saveSettings: vi.fn() }));
vi.mock('../connections', () => ({ ConnectionsPage: () => <p>connections page</p> }));
vi.mock('./api-tokens-section', () => ({ ApiTokensSection: () => <p>tokens section</p> }));

const roles = { plan: ['claude:opus'], implement: ['claude:sonnet'], review: ['claude:sonnet'] };
const view = (settings: SettingsView['settings'] = {}): SettingsView => ({
  settings,
  defaults: {
    agents: { main: roles, subtask: roles, backlog: { plan: ['claude:opus:high'] } },
    levels: {
      main: { plan: 'high', implement: 'high', review: 'high' },
      subtask: { plan: 'medium', implement: 'medium', review: 'medium' },
      backlog: { plan: 'xhigh' },
    },
  },
  runtimes: [
    { runtime: 'claude', models: ['opus', 'sonnet'], efforts: { opus: ['low', 'high'], sonnet: [] } },
    { runtime: 'codex', models: ['gpt', 'gpt-priced'], efforts: {} },
  ],
  modelsLimited: false,
  server: [
    { name: 'MAX_RUN_USD', group: 'Limits.', secret: false, source: 'default', value: '5' },
    { name: 'SWARMLOOP_SECRET', group: 'Authentication.', secret: true, source: 'default', value: 'set' },
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
  const user = userEvent.setup({ delay: null });
  render(<SettingsPage />);
  await screen.findByRole('list', { name: 'main plan' });
  return user;
}

describe('SettingsPage', () => {
  it('shows the env list read-only and saves nothing for a role on the server default', async () => {
    const user = userEvent.setup({ delay: null });
    render(<SettingsPage />);

    expect(await screen.findAllByLabelText('Server default for main plan')).toHaveLength(1);
    expect(screen.getByLabelText('Server default for main plan')).toHaveTextContent('claude:opus');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSettings).toHaveBeenCalledWith({});
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('shows the backlog tier with its plan role only', async () => {
    render(<SettingsPage />);
    expect(await screen.findByLabelText('Server default for backlog plan')).toHaveTextContent('claude:opus:high');
    expect(screen.getByLabelText('Use server default for backlog plan')).toBeInTheDocument();
    expect(screen.queryByLabelText('Use server default for backlog implement')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Use server default for backlog review')).not.toBeInTheDocument();
  });

  it('says which effort the default agents work at and what the epic effort lifts', async () => {
    render(<SettingsPage />);
    expect(
      await screen.findByText(
        "By default, subtask agents work at medium effort, and plan, implement and review work at high. When a run splits into subtasks, the epic effort setting lifts only the parent's planning.",
      ),
    ).toBeInTheDocument();
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

  it('offers the levels of the chosen model and no empty choice', async () => {
    const user = await openOwnPlan();

    await user.click(screen.getByRole('combobox', { name: 'Effort of claude:opus' }));

    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['low', 'high']);
  });

  it('shows the level an entry without an effort runs at and where it comes from', async () => {
    await openOwnPlan(own(['claude', 'opus']));
    expect(screen.getByRole('combobox', { name: 'Effort of claude:opus' })).toHaveTextContent(
      'high · default for plan',
    );
  });

  it('shows the level of the entry above, and the plain level for an own effort', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...view(),
      runtimes: [
        {
          runtime: 'claude',
          models: ['opus', 'sonnet'],
          efforts: { opus: ['low', 'high'], sonnet: ['low', 'high', 'xhigh'] },
        },
      ],
    });
    vi.mocked(getSettings).mockResolvedValue({
      ...(await getSettings()),
      settings: {
        agents: {
          main: {
            plan: [
              { runtime: 'claude', model: 'opus', effort: 'high' },
              { runtime: 'claude', model: 'sonnet' },
            ],
          },
        },
      },
    });
    render(<SettingsPage />);
    await screen.findByRole('list', { name: 'main plan' });
    expect(screen.getByRole('combobox', { name: 'Effort of claude:opus:high' })).toHaveTextContent(/^high$/);
    expect(screen.getByRole('combobox', { name: 'Effort of claude:sonnet' })).toHaveTextContent('high · as above');
  });

  it('shows the level before the cap on the next entry as xhigh when the entry above is max', async () => {
    vi.mocked(getSettings).mockResolvedValue({
      ...view({
        agents: {
          main: {
            plan: [
              { runtime: 'claude', model: 'opus', effort: 'max' },
              { runtime: 'codex', model: 'gpt' },
            ],
          },
        },
      }),
      runtimes: [
        { runtime: 'claude', models: ['opus'], efforts: { opus: ['low', 'high', 'xhigh', 'max'] } },
        { runtime: 'codex', models: ['gpt'], efforts: { gpt: ['low', 'high', 'xhigh'] } },
      ],
    });
    render(<SettingsPage />);
    await screen.findByRole('list', { name: 'main plan' });
    expect(screen.getByRole('combobox', { name: 'Effort of codex:gpt' })).toHaveTextContent('xhigh · as above');
  });

  it('adds a runtime and model that stores no effort', async () => {
    const user = await openOwnPlan();

    await user.click(screen.getByRole('combobox', { name: 'Add to main plan' }));
    await user.click(await screen.findByRole('option', { name: 'claude:sonnet' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSettings).toHaveBeenCalledWith({
      agents: {
        main: {
          plan: [
            { runtime: 'claude', model: 'opus' },
            { runtime: 'claude', model: 'sonnet' },
          ],
        },
      },
    });
  });

  it('sends a saved list back unchanged until a level is picked', async () => {
    const user = await openOwnPlan(own(['claude', 'opus']));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(saveSettings).toHaveBeenCalledWith(own(['claude', 'opus']));
  });

  it('offers no level for a model that has none', async () => {
    await openOwnPlan(own(['claude', 'sonnet']));

    expect(screen.queryByRole('combobox', { name: /^Effort of/ })).not.toBeInTheDocument();
  });

  it('saves the chosen level', async () => {
    const user = await openOwnPlan();

    await user.click(screen.getByRole('combobox', { name: 'Effort of claude:opus' }));
    await user.click(await screen.findByRole('option', { name: 'low' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSettings).toHaveBeenCalledWith({
      agents: { main: { plan: [{ runtime: 'claude', model: 'opus', effort: 'low' }] } },
    });
  });

  it('saves the level picked in place of an own one', async () => {
    const user = await openOwnPlan(ownHigh);

    await user.click(screen.getByRole('combobox', { name: 'Effort of claude:opus:high' }));
    await user.click(await screen.findByRole('option', { name: 'low' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(saveSettings).toHaveBeenCalledWith({
      agents: { main: { plan: [{ runtime: 'claude', model: 'opus', effort: 'low' }] } },
    });
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
    const user = userEvent.setup({ delay: null });
    render(<SettingsPage />);

    await screen.findByRole('button', { name: 'Save' });
    expect(screen.queryByText(/SPLIT/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(vi.mocked(saveSettings).mock.lastCall![0]).not.toHaveProperty('split');
  });

  it('shows what a server setting means under its value', async () => {
    const user = userEvent.setup({ delay: null });
    const described = view();
    described.server = [
      {
        name: 'CHECKS_PARALLEL',
        group: 'Limits.',
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
    const user = userEvent.setup({ delay: null });
    render(<SettingsPage />);
    await screen.findByRole('button', { name: 'Save' });

    await user.click(screen.getByRole('button', { name: 'Connections' }));
    expect(screen.getByText('connections page')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Server' }));
    expect(screen.getByText('MAX_RUN_USD')).toBeInTheDocument();
    expect(screen.getByText('set')).toBeInTheDocument();
  });

  it('shows where each server setting comes from, secrets included', async () => {
    const user = userEvent.setup({ delay: null });
    const sourced = view();
    sourced.server = [
      { name: 'MAX_RUN_USD', group: 'Limits.', secret: false, source: 'default', value: '5' },
      { name: 'MAX_RETURNS', group: 'Limits.', secret: false, source: '.env', value: '7' },
      { name: 'SWARMLOOP_SECRET', group: 'Authentication.', secret: true, source: 'environment', value: 'set' },
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

  it('says the Server section is read only and heads each group of defaults.env', async () => {
    const user = userEvent.setup({ delay: null });
    render(<SettingsPage />);
    await screen.findByRole('button', { name: 'Save' });

    await user.click(screen.getByRole('button', { name: 'Server' }));

    expect(
      screen.getByText(
        'Read only. Each value comes from .env, the environment or defaults.env. To change one, edit its line in .env and run docker compose up -d.',
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent)).toEqual([
      'Limits.',
      'Authentication.',
    ]);
  });

  it('lists API tokens, and no People and no Appearance entry', async () => {
    const user = userEvent.setup({ delay: null });
    render(<SettingsPage />);
    await screen.findAllByLabelText('Server default for main plan');
    const entries = within(screen.getByRole('navigation', { name: 'settings sections' })).getAllByRole('button');
    expect(entries.map((entry) => entry.textContent)).toEqual(['Agents', 'Connections', 'API tokens', 'Server']);
    await user.click(screen.getByRole('button', { name: 'API tokens' }));
    expect(screen.getByText('tokens section')).toBeInTheDocument();
  });
});
