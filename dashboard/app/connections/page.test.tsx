import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Page from './page';

vi.mock('../../features/connections', () => ({ ConnectionsPage: () => <p>connections stub</p> }));

beforeEach(() => {
  window.history.pushState({}, '', '/connections');
});

describe('Connections page', () => {
  it('shows a login problem above the connections', async () => {
    window.history.pushState({}, '', '/connections?error=host&host=github&reason=x');

    render(<Page />);

    expect(await screen.findByText('GitHub did not answer: x')).toBeInTheDocument();
    expect(screen.getByText('connections stub')).toBeInTheDocument();
  });
});
