import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReadinessProvider } from '../features/readiness';
import { Shell } from '../features/shell';
import { getReadiness } from '../lib/endpoints';
import { QueryWrapper } from '../test/query-wrapper';
import HomePage from './page';

vi.mock('../lib/endpoints', () => ({ getReadiness: vi.fn() }));
vi.mock('../lib/live', async () => (await import('../test/fake-socket')).fakeLive());

function renderPage(onNewRun = vi.fn()): void {
  render(
    <ReadinessProvider>
      <Shell onNewRun={onNewRun}>
        <HomePage />
      </Shell>
    </ReadinessProvider>,
    { wrapper: QueryWrapper },
  );
}

describe('HomePage', () => {
  it('disables New run and shows the action while an item fails', async () => {
    vi.mocked(getReadiness).mockResolvedValue({
      items: [{ id: 'docker', status: 'fail', line: 'docker is not running', action: 'start Docker' }],
    });
    renderPage();
    expect(await screen.findByText('start Docker')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New run' })).toBeDisabled();
  });

  it('keeps New run enabled when only warn items exist', async () => {
    const onNewRun = vi.fn();
    vi.mocked(getReadiness).mockResolvedValue({
      items: [{ id: 'images', status: 'warn', line: 'not pulled yet', action: 'pulled on the first run' }],
    });
    renderPage(onNewRun);
    await screen.findByText(/not pulled yet/);
    await userEvent.setup().click(screen.getByRole('button', { name: 'New run' }));
    expect(onNewRun).toHaveBeenCalled();
  });

  it('keeps New run enabled when the report cannot be read', async () => {
    vi.mocked(getReadiness).mockRejectedValue(new Error('boom'));
    renderPage();
    await screen.findByText(/boom/);
    expect(screen.getByRole('button', { name: 'New run' })).toBeEnabled();
  });
});
