import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RepositoryChip } from './repository-chip';

const reading = vi.hoisted(() => ({ state: 'pending' }));

vi.mock('../../lib/backlog-endpoints', () => ({
  getRepositoryMain: () => Promise.resolve({ state: reading.state, url: null }),
}));

describe('RepositoryChip', () => {
  it('says no CI for a main with none', async () => {
    reading.state = 'none';
    render(<RepositoryChip repository="api" />);

    await screen.findByLabelText('api: no CI');
    expect(screen.getByText('api · no CI')).toBeTruthy();
    reading.state = 'pending';
  });

  it('shows the turning ring while main is running', async () => {
    const { container } = render(<RepositoryChip repository="api" />);

    await screen.findByLabelText('api: main is running');
    expect(container.querySelector('svg path')).not.toBeNull();
    expect(container.querySelector('[data-testid="AutorenewIcon"]')).toBeNull();
  });
});
