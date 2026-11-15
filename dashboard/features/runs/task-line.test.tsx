import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { runSummary } from '../../test/fixtures';
import { TaskLine } from './task-line';

describe('TaskLine', () => {
  it('carries the whole run name on hover', async () => {
    const name = 'a long run name '.repeat(10).trim();
    render(<TaskLine run={{ ...runSummary(), name }} selected={false} onOpen={vi.fn()} onRemove={vi.fn()} />);

    await userEvent.hover(screen.getByText(name));

    expect(await screen.findByRole('tooltip')).toHaveTextContent(name);
  });
});
