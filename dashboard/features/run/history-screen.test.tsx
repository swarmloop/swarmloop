import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getHistory } from '../../lib/endpoints';
import userEvent from '@testing-library/user-event';
import { historyView } from '../../test/fixtures';
import { expectNoRawJson } from '../../test/raw-json';
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

  it('shows the documents by kind: the requirements structured, JSON as a table, the log as a transcript', async () => {
    const user = userEvent.setup();
    const at = { attempt: 1, createdAt: 't' };
    vi.mocked(getHistory).mockResolvedValue(
      historyView({
        documents: [
          { kind: 'requirements', body: JSON.stringify({ prompt: 'Ship the field', plan: { items: ['one'] } }), ...at },
          { kind: 'issues', body: JSON.stringify([{ title: 'a bug', tags: ['x', 'y'], meta: { line: 3 } }]), ...at },
          { kind: 'log', body: '{"type":"system","subtype":"init"}\n', ...at },
        ],
      }),
    );
    render(<HistoryScreen runKey="run-1" />);
    await user.click(await screen.findByText('Documents'));
    for (const kind of ['requirements', 'issues', 'log']) {
      await user.click(screen.getByText(kind));
    }

    expect(screen.getByText('Prompt')).toBeInTheDocument();
    expect(screen.getByText('Ship the field')).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('title: a bug; tags: x, y; meta: line: 3')).toBeInTheDocument();
    expectNoRawJson(document.body);
  });
});
