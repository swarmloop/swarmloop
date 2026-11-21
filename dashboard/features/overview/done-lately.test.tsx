import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getFlow, listRuns } from '../../lib/endpoints';
import { mergedRun, returnsFlow } from '../../test/overview-fixtures';
import { listRunsFrom } from '../../test/runs-page';
import { DoneLately } from './index';
import { PartsWrapper } from './test-wrapper.spec-helpers';

vi.mock('../../lib/endpoints', () => ({ listRuns: vi.fn(), getFlow: vi.fn() }));
vi.mock('../../lib/live', async () => (await import('../../test/fake-socket')).fakeLive());

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getFlow).mockImplementation((key) => Promise.resolve(returnsFlow(key, key === 'run-1' ? [1, 1] : [])));
});

describe('DoneLately', () => {
  it('shows five lines of seven done runs, each opening its run with the merge request as one more link', async () => {
    vi.mocked(listRuns).mockImplementation(
      listRunsFrom(Array.from({ length: 7 }, (_, index) => mergedRun(`run-${index + 1}`))),
    );
    render(<DoneLately />, { wrapper: PartsWrapper });
    expect(await screen.findByText('2 returns, all fixed')).toBeInTheDocument();
    const lines = screen.getAllByRole('listitem');
    expect(lines).toHaveLength(5);
    expect(screen.getAllByText('first pass')).toHaveLength(4);
    const first = lines[0];
    expect(within(first).getByText('Title of run-1').closest('a')).toHaveAttribute('href', '/runs/run-1');
    expect(within(first).getByText('12h 04m')).toBeInTheDocument();
    expect(within(first).getByText('$1.50')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'Merge request' })).toHaveAttribute(
      'href',
      'https://example.test/run-1/pull/1',
    );
  });

  it('renders nothing when there is no done run', async () => {
    vi.mocked(listRuns).mockImplementation(listRunsFrom([]));
    const { container } = render(<DoneLately />, { wrapper: PartsWrapper });
    await vi.waitFor(() => expect(listRuns).toHaveBeenCalledTimes(2));
    expect(container).toBeEmptyDOMElement();
  });
});
