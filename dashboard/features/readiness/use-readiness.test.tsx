import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReadinessItem } from '@contract/readiness';
import { ApiError } from '../../lib/api';
import { getReadiness } from '../../lib/endpoints';
import { QueryWrapper } from '../../test/query-wrapper';
import { ReadinessProvider, useReadiness } from './use-readiness';

vi.mock('../../lib/endpoints', () => ({ getReadiness: vi.fn() }));

const item = (id: ReadinessItem['id'], status: ReadinessItem['status']): ReadinessItem => ({
  id,
  status,
  line: `${id} line`,
  action: `${id} action`,
});

function Probe() {
  const { items, blocker, error, loading, refreshFailed, checkedAt } = useReadiness();
  return (
    <div>
      <p>items: {items.length}</p>
      <p>blocker: {blocker?.id ?? 'none'}</p>
      <p>loading: {String(loading)}</p>
      <p>refreshFailed: {String(refreshFailed)}</p>
      <p>checkedAt: {checkedAt ?? 'none'}</p>
      {error ? <p>error: {error}</p> : null}
    </div>
  );
}

function renderProbe(): void {
  render(
    <ReadinessProvider>
      <Probe />
    </ReadinessProvider>,
    { wrapper: QueryWrapper },
  );
}

const CHECKED_AT = '2026-01-01T00:00:00.000Z';

describe('useReadiness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('blocks on the first fail item', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [item('docker', 'ok'), item('disk', 'fail'), item('paths', 'fail')],
      checkedAt: CHECKED_AT,
    });
    renderProbe();
    expect(await screen.findByText('blocker: disk')).toBeInTheDocument();
    expect(screen.getByText('items: 3')).toBeInTheDocument();
  });

  it('does not block on warn items', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [item('images', 'warn'), item('docker', 'ok')],
      checkedAt: CHECKED_AT,
    });
    renderProbe();
    expect(await screen.findByText('items: 2')).toBeInTheDocument();
    expect(screen.getByText('blocker: none')).toBeInTheDocument();
  });

  it('does not block when the report cannot be read, and gives the error text', async () => {
    vi.mocked(getReadiness).mockRejectedValue(new Error('boom'));
    renderProbe();
    expect(await screen.findByText('error: boom')).toBeInTheDocument();
    expect(screen.getByText('blocker: none')).toBeInTheDocument();
  });

  it('refreshes every minute and on window focus, and keeps the last report when a refresh fails', async () => {
    vi.useFakeTimers();
    vi.mocked(getReadiness).mockReset();
    vi.mocked(getReadiness).mockResolvedValue({ items: [item('disk', 'fail')], checkedAt: CHECKED_AT });
    renderProbe();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(getReadiness).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(getReadiness).toHaveBeenCalledTimes(2);
    await act(async () => {
      fireEvent.focus(window);
      window.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(getReadiness).toHaveBeenCalledTimes(3);
    vi.mocked(getReadiness).mockRejectedValue(new Error('boom'));
    await act(() => vi.advanceTimersByTimeAsync(61_000));
    expect(screen.getByText('refreshFailed: true')).toBeInTheDocument();
    expect(screen.getByText('blocker: disk')).toBeInTheDocument();
    expect(screen.getByText(`checkedAt: ${CHECKED_AT}`)).toBeInTheDocument();
    expect(screen.queryByText('error: boom')).not.toBeInTheDocument();
  });

  it('counts an empty report without a time as loading, and one with items as a report', async () => {
    vi.mocked(getReadiness).mockResolvedValue({ items: [], checkedAt: null });
    renderProbe();
    expect(await screen.findByText('items: 0')).toBeInTheDocument();
    expect(screen.getByText('loading: true')).toBeInTheDocument();
  });

  it('is not loading for a report with items and no time', async () => {
    vi.mocked(getReadiness).mockResolvedValue({ items: [item('docker', 'ok')], checkedAt: null });
    renderProbe();
    expect(await screen.findByText('items: 1')).toBeInTheDocument();
    expect(screen.getByText('loading: false')).toBeInTheDocument();
  });

  it('retries sooner than a minute while the server is busy', async () => {
    vi.useFakeTimers();
    vi.mocked(getReadiness).mockReset();
    vi.mocked(getReadiness).mockRejectedValue(new ApiError(503, 'The server is busy, retrying', true));
    renderProbe();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(getReadiness).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(vi.mocked(getReadiness).mock.calls.length).toBeGreaterThan(1);
    expect(screen.getByText('error: The server is busy, retrying')).toBeInTheDocument();
  });

  it('asks again within seconds after the first empty report, then shows the built one', async () => {
    vi.useFakeTimers();
    vi.mocked(getReadiness).mockReset();
    vi.mocked(getReadiness)
      .mockResolvedValueOnce({ items: [], checkedAt: null })
      .mockResolvedValue({ items: [item('docker', 'fail')], checkedAt: '2026-11-13T10:00:00Z' });
    renderProbe();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByText('loading: true')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(getReadiness).toHaveBeenCalledTimes(2);
    expect(screen.getByText('items: 1')).toBeInTheDocument();
    expect(screen.getByText('loading: false')).toBeInTheDocument();
  });
});
