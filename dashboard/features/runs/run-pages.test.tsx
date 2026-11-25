import { act, render, screen } from '@testing-library/react';
import { useEffect } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunSummary } from '@contract/api';
import { listRuns } from '../../lib/endpoints';
import { fakeIntersectionObserver } from '../../test/intersection-observer';
import { runSummary } from '../../test/fixtures';
import { listRunsFrom } from '../../test/runs-page';
import { LiveBridgeProvider, useLiveActions } from '../shell';
import { LoadMoreRow } from './load-more-row';
import { RunColumn } from './run-column';
import { useRuns } from './use-runs';

vi.mock('next/navigation', () => ({ usePathname: vi.fn(), useRouter: vi.fn(), useSearchParams: vi.fn() }));
vi.mock('../../lib/endpoints', () => ({ listRuns: vi.fn(), removeRun: vi.fn() }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

const intersection = fakeIntersectionObserver();

function Column() {
  const list = useRuns();
  return (
    <RunColumn
      {...list}
      onLoadMore={list.loadMore}
      selected=""
      onRetry={list.retry}
      onOpen={vi.fn()}
      onRemove={vi.fn()}
    />
  );
}

/** The paging of a part without the rows' own markup: a row costs more to render than a page costs to load. */
function Pages({ part }: { part: 'done' }) {
  const list = useRuns();
  const { showList } = useLiveActions();
  useEffect(() => showList(part, ''), [showList, part]);
  return (
    <>
      {list.runs.map((item) => (
        <p key={item.key}>{item.key}</p>
      ))}
      {list.next !== null ? <LoadMoreRow onLoadMore={list.loadMore} /> : null}
    </>
  );
}

const run = (key: string, overrides: Partial<RunSummary> = {}): RunSummary => ({
  ...runSummary(),
  key,
  name: key,
  title: key,
  ...overrides,
});
const merged = (n: number): RunSummary => run(`Merged ${n}`, { state: 'merged', status: 'done' });

function show(part: string): void {
  vi.mocked(useSearchParams).mockReturnValue(
    new URLSearchParams(`show=${part}`) as unknown as ReturnType<typeof useSearchParams>,
  );
}

beforeEach(() => {
  vi.mocked(usePathname).mockReturnValue('/');
  vi.mocked(useRouter).mockReturnValue({ push: vi.fn(), replace: vi.fn() } as unknown as ReturnType<typeof useRouter>);
});

describe('the run list by part and page', () => {
  it('Done loads its first page when chosen and the next when the list is scrolled to its end', async () => {
    const rows = [run('Working'), ...Array.from({ length: 45 }, (_, n) => merged(n))];
    vi.mocked(listRuns).mockImplementation(listRunsFrom(rows));
    render(<Pages part="done" />, { wrapper: LiveBridgeProvider });
    await act(async () => {});

    expect(screen.getByText('Merged 19')).toBeInTheDocument();
    expect(screen.queryByText('Merged 20')).not.toBeInTheDocument();
    expect(screen.queryByText('Working')).not.toBeInTheDocument();
    expect(listRuns).toHaveBeenCalledWith({ part: 'done', q: '' });

    intersection.scrollIntoView();
    await act(async () => {});

    expect(screen.getByText('Merged 39')).toBeInTheDocument();
    expect(screen.getByText('Merged 0')).toBeInTheDocument();
    expect(listRuns).toHaveBeenLastCalledWith({ part: 'done', q: '', cursor: '20' });

    intersection.scrollIntoView();
    await act(async () => {});

    expect(screen.getByText('Merged 44')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('the tab counts come from the server', async () => {
    vi.mocked(listRuns).mockResolvedValue({
      runs: [run('Working')],
      counts: { active: 3, done: 232, all: 235 },
      otherMatches: 0,
      next: null,
    });
    show('active');

    render(<Column />, { wrapper: LiveBridgeProvider });

    expect(await screen.findByRole('button', { name: 'Active 3' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Done 232' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'All 235' })).toBeInTheDocument();
  });
});
