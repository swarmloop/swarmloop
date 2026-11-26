import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RepositoryChip } from './repository-chip';

vi.mock('../../lib/backlog-endpoints', () => ({
  getRepositoryMain: () => Promise.resolve({ state: 'pending', url: null }),
}));

describe('RepositoryChip', () => {
  it('shows the turning ring while main is running', async () => {
    const { container } = render(<RepositoryChip repository="api" />);

    await screen.findByLabelText('api: main is running');
    expect(container.querySelector('svg path')).not.toBeNull();
    expect(container.querySelector('[data-testid="AutorenewIcon"]')).toBeNull();
  });
});
