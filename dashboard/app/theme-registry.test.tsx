import { act, cleanup, render, screen } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../lib/api';
import { ThemeRegistry } from './theme-registry';

function Probe({ queryFn }: { queryFn: () => Promise<never> }): React.ReactElement {
  const { status } = useQuery({ queryKey: ['probe'], queryFn });
  return <p>{status}</p>;
}

function failWith(error: Error, attemptTimes: number[]): () => Promise<never> {
  return () => {
    attemptTimes.push(Date.now());
    return Promise.reject(error);
  };
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
  cleanup();
  vi.useRealTimers();
});

describe('ThemeRegistry query defaults', () => {
  it('retries a busy query with a delay that doubles from 1 s up to 30 s', async () => {
    const started = Date.now();
    const attemptTimes: number[] = [];
    await renderProbe(failWith(new ApiError(503, 'The server is busy, retrying', true), attemptTimes));

    await act(() => vi.advanceTimersByTimeAsync(91_000));

    expect(attemptTimes.map((time) => time - started)).toEqual([0, 1000, 3000, 7000, 15000, 31000, 61000, 91000]);
    expect(screen.getByText('pending')).toBeTruthy();
  });

  it('gives another error three retries and then shows it', async () => {
    const started = Date.now();
    const attemptTimes: number[] = [];
    await renderProbe(failWith(new ApiError(500, 'HTTP 500'), attemptTimes));

    await act(() => vi.advanceTimersByTimeAsync(60_000));

    expect(attemptTimes.map((time) => time - started)).toEqual([0, 1000, 3000, 7000]);
    expect(screen.getByText('error')).toBeTruthy();
  });
});
