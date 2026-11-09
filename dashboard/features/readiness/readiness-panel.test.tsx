import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { getReadiness } from '../../lib/endpoints';
import { QueryWrapper } from '../../test/query-wrapper';
import { ReadinessPanel } from './readiness-panel';
import { ReadinessProvider } from './use-readiness';

vi.mock('../../lib/endpoints', () => ({ getReadiness: vi.fn() }));

function renderPanel(): void {
  render(
    <ReadinessProvider>
      <ReadinessPanel />
    </ReadinessProvider>,
    { wrapper: QueryWrapper },
  );
}

describe('ReadinessPanel', () => {
  it('shows each item with its action unless it is ok', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [
        { id: 'docker', status: 'ok', line: 'docker answers', action: 'nothing to do' },
        { id: 'disk', status: 'fail', line: '2.0 GB free', action: 'free some disk space' },
      ],
    });
    renderPanel();
    expect(await screen.findByText(/2\.0 GB free/)).toHaveTextContent('free some disk space');
    expect(screen.getByText(/docker answers/)).not.toHaveTextContent('nothing to do');
  });

  it('shows the error text when the report cannot be read', async () => {
    vi.mocked(getReadiness).mockRejectedValue(new Error('api is down'));
    renderPanel();
    expect(await screen.findByText(/Readiness is not available: api is down/)).toBeInTheDocument();
  });
});
