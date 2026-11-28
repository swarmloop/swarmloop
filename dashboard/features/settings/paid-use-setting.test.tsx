import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SettingsBody } from '@contract/api';
import type { SettingsView } from '@contract/settings';
import { PaidUseSetting } from './paid-use-setting';

const view = {
  paidUse: [
    { runtime: 'claude', label: 'Claude', readsPaidUse: true },
    { runtime: 'codex', label: 'Codex', readsPaidUse: false },
    { runtime: 'cursor', label: 'Cursor', readsPaidUse: false },
  ],
} as SettingsView;
const switchOf = (label: string): HTMLElement =>
  screen.getByRole('switch', { name: `Let my agents use paid usage past my plan's limit on ${label}` });

function show(draft: SettingsBody = {}): ReturnType<typeof vi.fn> {
  const onChange = vi.fn();
  render(<PaidUseSetting view={view} draft={draft} onChange={onChange} />);
  return onChange;
}

describe('PaidUseSetting', () => {
  it('is off for a runtime that shows its paid use when nothing is saved', () => {
    show();
    expect(switchOf('Claude')).not.toBeChecked();
    expect(switchOf('Claude')).toBeEnabled();
  });

  it('sets paysPastLimit on one click and keeps the agents of the draft', async () => {
    const agents = { main: { plan: [{ runtime: 'claude', model: 'opus' }] } };
    const onChange = show({ agents });
    await userEvent.setup({ delay: null }).click(switchOf('Claude'));
    expect(onChange).toHaveBeenCalledWith({ agents, paysPastLimit: true });
  });

  it('shows a saved choice as on', () => {
    show({ paysPastLimit: true });
    expect(switchOf('Claude')).toBeChecked();
  });

  it('shows Codex and Cursor on and locked, each with the note to set a cap at the provider', () => {
    const onChange = show();
    for (const label of ['Codex', 'Cursor']) {
      expect(switchOf(label)).toBeChecked();
      expect(switchOf(label)).toBeDisabled();
      expect(
        screen.getByText(`swarmloop cannot see paid use on ${label}, so set a spend cap at the provider.`),
      ).toBeInTheDocument();
    }
    expect(screen.queryByText(/cannot see paid use on Claude/)).toBeNull();
    fireEvent.click(switchOf('Codex'));
    fireEvent.click(switchOf('Cursor'));
    expect(onChange).not.toHaveBeenCalled();
  });
});
