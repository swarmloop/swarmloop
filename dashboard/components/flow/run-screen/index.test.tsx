import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../../lib/api';
import { flowView, stepView } from '../../../test/fixtures';
import { RunScreen } from './index';

vi.mock('../../../lib/api', () => ({ api: vi.fn(), runLog: vi.fn() }));
vi.mock('../../../lib/live', async () => (await import('../../../test/fake-socket')).fakeLive());

beforeEach(() => {
  vi.mocked(api).mockImplementation(async (path: string) => {
    if (path === '/runs/run-1') {
      return flowView({ status: 'done' });
    }
    if (path === '/runs/run-1/steps/implement') {
      return stepView();
    }
    if (path === '/checkouts/projects') {
      return { projects: [] };
    }
    throw new Error(`unexpected ${path}`);
  });
});

describe('RunScreen', () => {
  it('shows Loading the run. until the flow loads, then the flow name and board', async () => {
    render(<RunScreen runKey="run-1" />);

    expect(screen.getByText('Loading the run.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Run one' })).toBeInTheDocument();
    expect(screen.getByText('implementation')).toBeInTheDocument();
  });

  it('opens the run dialog titled with the step on Run again', async () => {
    const user = userEvent.setup();
    render(<RunScreen runKey="run-1" />);

    await user.click(await screen.findByRole('button', { name: 'Run again' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('heading', { name: 'implement' })).toBeInTheDocument();
  });
});
