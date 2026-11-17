import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getHistory } from '../../lib/endpoints';
import userEvent from '@testing-library/user-event';
import { receive } from '../../test/fake-socket';
import { historyView, runSummary } from '../../test/fixtures';
import { expectNoRawJson } from '../../test/raw-json';
import { LiveBridgeProvider } from '../shell';
import { HistoryScreen } from './history-screen';

vi.mock('../../lib/endpoints', () => ({ getHistory: vi.fn() }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

describe('HistoryScreen', () => {
  it('shows a skeleton first, then the run key and a link back to the flow', async () => {
    vi.mocked(getHistory).mockResolvedValue(historyView());

    render(<HistoryScreen runKey="run-1" />, { wrapper: LiveBridgeProvider });

    expect(screen.getByLabelText('Loading history')).toBeInTheDocument();
    expect(screen.queryByText('Loading history.')).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'run-1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to the flow' })).toHaveAttribute('href', '/runs/run-1');
    expect(getHistory).toHaveBeenCalledWith('run-1');
  });

  it('shows the error when the history fails to load and loads it again on Retry', async () => {
    const user = userEvent.setup({ delay: null });
    vi.mocked(getHistory).mockRejectedValueOnce(new Error('history unavailable')).mockResolvedValue(historyView());

    render(<HistoryScreen runKey="run-1" />, { wrapper: LiveBridgeProvider });

    expect(await screen.findByText(/history unavailable/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('heading', { name: 'run-1' })).toBeInTheDocument();
    expect(screen.queryByText(/history unavailable/)).not.toBeInTheDocument();
  });

  it('is titled with the title of the run and sets the tab, with the key as the fallback', async () => {
    vi.mocked(getHistory).mockResolvedValue(historyView());
    render(<HistoryScreen runKey="run-1" />, { wrapper: LiveBridgeProvider });
    expect(await screen.findByRole('heading', { name: 'run-1' })).toBeInTheDocument();
    expect(document.title).toBe('run-1 · swarmloop');

    act(() => receive('runs', { runs: [{ ...runSummary(), key: 'run-1', title: 'Add a stats page' }] }));

    expect(screen.getByRole('heading', { name: 'Add a stats page' })).toBeInTheDocument();
    expect(document.title).toBe('Add a stats page · swarmloop');
  });

  it('shows the documents by kind: the requirements structured, JSON as a table, the log as a transcript', async () => {
    const user = userEvent.setup({ delay: null });
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
    render(<HistoryScreen runKey="run-1" />, { wrapper: LiveBridgeProvider });
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

  it('marks a return that only CI caught', async () => {
    const at = { createdAt: 't' };
    vi.mocked(getHistory).mockResolvedValue(
      historyView({
        loops: [
          { counter: 'pipeline', attempt: 1, reason: 'CI job docker failed; no check covers it', ciOnly: true, ...at },
          { counter: 'checks', attempt: 1, reason: 'required checks failed', ...at },
        ],
      }),
    );

    render(<HistoryScreen runKey="run-1" />, { wrapper: LiveBridgeProvider });

    expect(await screen.findByText(/pipeline 1: CI job docker failed.*CI only/)).toBeInTheDocument();
    expect(screen.getByText('checks 1: required checks failed')).toBeInTheDocument();
  });
});
