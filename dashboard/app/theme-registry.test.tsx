import { act, render, screen } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { ThemeRegistry } from './theme-registry';

function Probe({ queryFn }: { queryFn: () => Promise<never> }): React.ReactElement {
  const { status } = useQuery({ queryKey: ['probe'], queryFn });
  return <p>{status}</p>;
}

function failWith(error: Error): ReturnType<typeof vi.fn<() => Promise<never>>> {
  return vi.fn<() => Promise<never>>().mockRejectedValue(error);
}

async function renderProbe(queryFn: () => Promise<never>): Promise<void> {
  render(
    <ThemeRegistry>
      <Probe queryFn={queryFn} />
    </ThemeRegistry>,
  );
  await act(() => vi.advanceTimersByTimeAsync(0));
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ThemeRegistry query defaults', () => {
  it('retries a busy query with a delay that doubles from 1 s up to 30 s', async () => {
    const queryFn = failWith(new ApiError(503, 'The server is busy, retrying', true));
    await renderProbe(queryFn);
    expect(queryFn).toHaveBeenCalledTimes(1);

    for (const [index, seconds] of [1, 2, 4, 8, 16, 30, 30].entries()) {
      await act(() => vi.advanceTimersByTimeAsync(seconds * 1000 - 1));
      expect(queryFn).toHaveBeenCalledTimes(index + 1);
      await act(() => vi.advanceTimersByTimeAsync(1));
      expect(queryFn).toHaveBeenCalledTimes(index + 2);
    }
    expect(screen.getByText('pending')).toBeTruthy();
  });

  it('gives another error three retries and then shows it', async () => {
    const queryFn = failWith(new ApiError(500, 'HTTP 500'));
    await renderProbe(queryFn);

    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(queryFn).toHaveBeenCalledTimes(4);
    expect(screen.getByText('error')).toBeTruthy();
  });
});
