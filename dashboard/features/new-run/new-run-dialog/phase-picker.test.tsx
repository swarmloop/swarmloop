import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PhaseName } from '@contract/steps';
import { PhasePicker } from './phase-picker';

function picker(picked: PhaseName[]) {
  const setPicked = vi.fn();
  render(<PhasePicker picked={picked} frozen={['planning']} setPicked={setPicked} />);
  return setPicked;
}

describe('PhasePicker', () => {
  it('shows each phase under its label', () => {
    picker(['planning']);

    for (const label of ['planning', 'implementation', 'checks', 'code review', 'ci']) {
      expect(screen.getByRole('checkbox', { name: label })).toBeInTheDocument();
    }
  });

  it('keeps requirements checked and disabled', () => {
    picker(['planning']);

    const planning = screen.getByRole('checkbox', { name: 'planning' });
    expect(planning).toBeChecked();
    expect(planning).toBeDisabled();
  });

  it('calls setPicked when another phase is toggled', async () => {
    const user = userEvent.setup();
    const setPicked = picker(['planning']);

    await user.click(screen.getByRole('checkbox', { name: 'checks' }));

    expect(setPicked).toHaveBeenCalledWith(expect.any(Function));
  });
});
