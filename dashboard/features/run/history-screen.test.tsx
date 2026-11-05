import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getHistory } from '../../lib/endpoints';
import { historyView } from '../../test/fixtures';
import { HistoryScreen } from './history-screen';

vi.mock('../../lib/endpoints', () => ({ getHistory: vi.fn() }));

describe('HistoryScreen', () => {
  it('shows Loading history. first, then the run key and a link back to the flow', async () => {
    vi.mocked(getHistory).mockResolvedValue(historyView());

    render(<HistoryScreen runKey="run-1" />);

    expect(screen.getByText('Loading history.')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'run-1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the flow' })).toHaveAttribute('href', '/runs/run-1');
    expect(getHistory).toHaveBeenCalledWith('run-1');
  });

  it('shows the error when the history fails to load', async () => {
    vi.mocked(getHistory).mockRejectedValue(new Error('history unavailable'));

    render(<HistoryScreen runKey="run-1" />);

    expect(await screen.findByText('history unavailable')).toBeInTheDocument();
  });
});
