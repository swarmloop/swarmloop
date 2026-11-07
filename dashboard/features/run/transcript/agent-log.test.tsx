import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AgentLogPanel } from './agent-log';

const agent = { logs: '{"type":"result"}\n', running: true, exchanges: [] };

describe('AgentLogPanel', () => {
  it('is open until the first tool event and collapsed behind show raw log after it', () => {
    const view = render(<AgentLogPanel agent={agent} tools={false} />);
    expect(screen.getByRole('button', { name: 'hide log' })).toHaveAttribute('aria-expanded', 'true');

    view.rerender(<AgentLogPanel agent={agent} tools />);
    expect(screen.getByRole('button', { name: 'show raw log' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps a reader that closed it before the first tool event, and one that opened it after', async () => {
    const user = userEvent.setup();
    const closed = render(<AgentLogPanel agent={agent} tools={false} />);
    await user.click(screen.getByRole('button', { name: 'hide log' }));
    closed.rerender(<AgentLogPanel agent={agent} tools />);
    expect(screen.getByRole('button', { name: 'show raw log' })).toHaveAttribute('aria-expanded', 'false');
    closed.unmount();

    const opened = render(<AgentLogPanel agent={agent} tools />);
    await user.click(screen.getByRole('button', { name: 'show raw log' }));
    opened.rerender(<AgentLogPanel agent={agent} tools />);
    expect(screen.getByRole('button', { name: 'show raw log' })).toHaveAttribute('aria-expanded', 'true');
  });
});
