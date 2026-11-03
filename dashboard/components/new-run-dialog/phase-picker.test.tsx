import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { PhaseName } from '@contract/steps';
import { PhasePicker } from './phase-picker';

function picker(picked: PhaseName[]) {
  const setPicked = vi.fn();
  render(<PhasePicker picked={picked} frozen={['requirements']} setPicked={setPicked} />);
  return setPicked;
}

describe('PhasePicker', () => {
  it('shows each phase under its label', () => {
    picker(['requirements']);

    for (const label of ['requirements', 'planning', 'implementation', 'code review', 'ci']) {
      expect(screen.getByRole('checkbox', { name: label })).toBeInTheDocument();
    }
  });

  it('keeps requirements checked and disabled', () => {
    picker(['requirements']);

    const requirements = screen.getByRole('checkbox', { name: 'requirements' });
    expect(requirements).toBeChecked();
    expect(requirements).toBeDisabled();
  });

  it('adds a phase through setPicked when another phase is toggled on', async () => {
    const user = userEvent.setup();
    const setPicked = picker(['requirements']);

    await user.click(screen.getByRole('checkbox', { name: 'planning' }));

    const update = setPicked.mock.calls[0][0] as (current: PhaseName[]) => PhaseName[];
    expect(update(['requirements'])).toEqual(['requirements', 'brainstorm']);
  });
});
